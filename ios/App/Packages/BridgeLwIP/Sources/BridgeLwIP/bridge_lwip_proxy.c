#include "bridge_lwip.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#define PROXY_MAX_HEADER 65536
#define PROXY_MAX_TARGET 8192
#define PROXY_MAX_TOKEN 4096
#define PROXY_MAX_CLIENTS 12

/*
 * A loopback-only reverse proxy is used because WKWebView has no supported
 * per-instance SOCKS configuration. It forwards requests to one fixed IPv4
 * target through lwIP and adds the bearer token that was read from the native
 * Keychain. The listener exists only while the experimental WebView is open.
 */
struct proxy_client {
  int fd;
  struct proxy_client *next;
};

static struct {
  pthread_mutex_t mutex;
  pthread_cond_t stopped;
  pthread_t accept_thread;
  int listener;
  int running;
  int active;
  struct proxy_client *clients;
  char address[INET_ADDRSTRLEN];
  uint16_t port;
  char token[PROXY_MAX_TOKEN];
} proxy = {
  .mutex = PTHREAD_MUTEX_INITIALIZER,
  .stopped = PTHREAD_COND_INITIALIZER,
  .listener = -1,
};

static int proxy_is_running(void) {
  pthread_mutex_lock(&proxy.mutex);
  const int result = proxy.running;
  pthread_mutex_unlock(&proxy.mutex);
  return result;
}

static int local_write_all(int fd, const uint8_t *bytes, size_t length) {
  while (length > 0) {
    const ssize_t written = send(fd, bytes, length, 0);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) return -1;
    bytes += written;
    length -= (size_t)written;
  }
  return 0;
}

static int remote_write_all(int fd, const uint8_t *bytes, size_t length) {
  int attempts = 0;
  while (length > 0 && proxy_is_running() && attempts++ < 10 * 1000) {
    const int written = bridge_lwip_tcp_write(fd, bytes, length);
    if (written == -2) {
      usleep(1000);
      continue;
    }
    if (written <= 0) return -1;
    bytes += written;
    length -= (size_t)written;
  }
  return length == 0 ? 0 : -1;
}

static const uint8_t *find_bytes(const uint8_t *bytes, size_t length,
                                 const uint8_t *needle, size_t needle_length) {
  if (needle_length == 0 || length < needle_length) return NULL;
  for (size_t index = 0; index + needle_length <= length; index++) {
    if (memcmp(bytes + index, needle, needle_length) == 0) return bytes + index;
  }
  return NULL;
}

static int read_request_headers(int fd, uint8_t *buffer, size_t capacity,
                                size_t *received, size_t *header_length) {
  *received = 0;
  *header_length = 0;
  static const uint8_t terminator[] = {'\r', '\n', '\r', '\n'};
  while (*received < capacity) {
    const ssize_t count = recv(fd, buffer + *received, capacity - *received, 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return -1;
    *received += (size_t)count;
    const uint8_t *end = find_bytes(buffer, *received, terminator, sizeof(terminator));
    if (end) {
      *header_length = (size_t)(end - buffer) + sizeof(terminator);
      return 0;
    }
  }
  return -1;
}

static int header_name_equals(const uint8_t *line, size_t length, const char *name) {
  const uint8_t *colon = memchr(line, ':', length);
  if (!colon) return 0;
  const size_t name_length = strlen(name);
  const size_t actual_length = (size_t)(colon - line);
  return actual_length == name_length && strncasecmp((const char *)line, name, name_length) == 0;
}

static const uint8_t *header_value_start(const uint8_t *line, size_t length, size_t *value_length) {
  const uint8_t *colon = memchr(line, ':', length);
  if (!colon) return NULL;
  const uint8_t *start = colon + 1;
  const uint8_t *end = line + length;
  while (start < end && (*start == ' ' || *start == '\t')) start++;
  while (end > start && (end[-1] == ' ' || end[-1] == '\t')) end--;
  *value_length = (size_t)(end - start);
  return start;
}

static int value_has_token(const uint8_t *value, size_t length, const char *token) {
  const size_t token_length = strlen(token);
  size_t start = 0;
  while (start < length) {
    while (start < length && (value[start] == ' ' || value[start] == '\t' || value[start] == ',')) start++;
    size_t end = start;
    while (end < length && value[end] != ',' && value[end] != ' ' && value[end] != '\t') end++;
    if (end - start == token_length && strncasecmp((const char *)value + start, token, token_length) == 0) return 1;
    start = end;
  }
  return 0;
}

static int request_has_header_value(const uint8_t *headers, size_t header_length,
                                    const char *name, const char *token) {
  size_t offset = 0;
  int first = 1;
  while (offset + 2 <= header_length) {
    const uint8_t *line_end = find_bytes(headers + offset, header_length - offset,
                                         (const uint8_t *)"\r\n", 2);
    if (!line_end) break;
    const size_t line_length = (size_t)(line_end - (headers + offset));
    if (line_length == 0) break;
    if (!first && header_name_equals(headers + offset, line_length, name)) {
      size_t value_length = 0;
      const uint8_t *value = header_value_start(headers + offset, line_length, &value_length);
      if (value && value_has_token(value, value_length, token)) return 1;
    }
    first = 0;
    offset += line_length + 2;
  }
  return 0;
}

static int append_bytes(uint8_t *output, size_t capacity, size_t *length,
                        const uint8_t *bytes, size_t count) {
  if (*length > capacity || count > capacity - *length) return -1;
  memcpy(output + *length, bytes, count);
  *length += count;
  return 0;
}

static int append_text(uint8_t *output, size_t capacity, size_t *length, const char *text) {
  return append_bytes(output, capacity, length, (const uint8_t *)text, strlen(text));
}

static int append_format(uint8_t *output, size_t capacity, size_t *length, const char *format, ...) {
  va_list arguments;
  va_start(arguments, format);
  const int needed = vsnprintf((char *)output + *length, capacity - *length, format, arguments);
  va_end(arguments);
  if (needed < 0 || (size_t)needed >= capacity - *length) return -1;
  *length += (size_t)needed;
  return 0;
}

static int clean_target(const char *target, char *output, size_t capacity) {
  const char *query = strchr(target, '?');
  if (!query) {
    if (strlen(target) + 1 > capacity) return -1;
    strcpy(output, target);
    return 0;
  }
  const size_t path_length = (size_t)(query - target);
  if (path_length + 2 > capacity) return -1;
  memcpy(output, target, path_length);
  size_t output_length = path_length;
  int kept = 0;
  const char *part = query + 1;
  while (*part) {
    const char *end = strchr(part, '&');
    const size_t part_length = end ? (size_t)(end - part) : strlen(part);
    if (output_length + part_length + 2 > capacity) return -1;
    output[output_length++] = kept ? '&' : '?';
    memcpy(output + output_length, part, part_length);
    output_length += part_length;
    kept = 1;
    if (!end) break;
    part = end + 1;
  }
  output[output_length] = 0;
  return 0;
}

static int parse_request_line(const uint8_t *headers, size_t header_length,
                              char *method, size_t method_capacity,
                              char *target, size_t target_capacity,
                              char *version, size_t version_capacity) {
  const uint8_t *line_end = find_bytes(headers, header_length, (const uint8_t *)"\r\n", 2);
  if (!line_end) return -1;
  const size_t line_length = (size_t)(line_end - headers);
  const uint8_t *first_space = memchr(headers, ' ', line_length);
  if (!first_space) return -1;
  const uint8_t *second_space = memchr(first_space + 1, ' ', line_length - (size_t)(first_space + 1 - headers));
  if (!second_space || first_space == headers || second_space == first_space + 1) return -1;
  const size_t method_length = (size_t)(first_space - headers);
  const size_t target_length = (size_t)(second_space - first_space - 1);
  const size_t version_length = line_length - (size_t)(second_space - headers) - 1;
  if (method_length + 1 > method_capacity || target_length + 1 > target_capacity || version_length + 1 > version_capacity) return -1;
  memcpy(method, headers, method_length); method[method_length] = 0;
  memcpy(target, first_space + 1, target_length); target[target_length] = 0;
  memcpy(version, second_space + 1, version_length); version[version_length] = 0;
  return target[0] == '/' && strncmp(version, "HTTP/1.", 7) == 0 ? 0 : -1;
}

static int build_forward_request(const uint8_t *headers, size_t header_length,
                                 uint8_t *output, size_t capacity,
                                 int *is_websocket) {
  char method[32], target[PROXY_MAX_TARGET], clean[PROXY_MAX_TARGET], version[16];
  if (parse_request_line(headers, header_length, method, sizeof(method), target, sizeof(target), version, sizeof(version)) != 0 ||
      clean_target(target, clean, sizeof(clean)) != 0) return -1;

  *is_websocket = request_has_header_value(headers, header_length, "Upgrade", "websocket") &&
      request_has_header_value(headers, header_length, "Connection", "upgrade");
  size_t output_length = 0;
  if (append_format(output, capacity, &output_length, "%s %s %s\r\n", method, clean, version) != 0) return -1;

  const uint8_t *line = find_bytes(headers, header_length, (const uint8_t *)"\r\n", 2);
  if (!line) return -1;
  size_t offset = (size_t)(line - headers) + 2;
  while (offset + 2 <= header_length) {
    const uint8_t *line_end = find_bytes(headers + offset, header_length - offset,
                                         (const uint8_t *)"\r\n", 2);
    if (!line_end) return -1;
    const size_t line_length = (size_t)(line_end - (headers + offset));
    if (line_length == 0) break;
    const uint8_t *current = headers + offset;
    if (!header_name_equals(current, line_length, "Host") &&
        !header_name_equals(current, line_length, "Authorization") &&
        !header_name_equals(current, line_length, "Connection") &&
        !header_name_equals(current, line_length, "Proxy-Connection") &&
        !header_name_equals(current, line_length, "Keep-Alive") &&
        !header_name_equals(current, line_length, "Origin") &&
        !header_name_equals(current, line_length, "X-Bridge-App-Proxy-Key")) {
      if (append_bytes(output, capacity, &output_length, current, line_length) != 0 ||
          append_text(output, capacity, &output_length, "\r\n") != 0) return -1;
    }
    offset += line_length + 2;
  }
  if (append_format(output, capacity, &output_length, "Host: %s:%u\r\n", proxy.address, proxy.port) != 0 ||
      append_format(output, capacity, &output_length, "Origin: http://%s:%u\r\n", proxy.address, proxy.port) != 0 ||
      append_format(output, capacity, &output_length, "Authorization: Bearer %s\r\n", proxy.token) != 0 ||
      append_text(output, capacity, &output_length, *is_websocket ? "Connection: Upgrade\r\n\r\n" : "Connection: close\r\n\r\n") != 0) return -1;
  return (int)output_length;
}

static void send_preflight(int fd) {
  static const char response[] =
      "HTTP/1.1 204 No Content\r\n"
      "Access-Control-Allow-Origin: capacitor://localhost\r\n"
      "Access-Control-Allow-Methods: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS\r\n"
      "Access-Control-Allow-Headers: Accept, Authorization, Content-Type, X-Bridge-Action-Token, X-Bridge-App-Proxy-Key, X-Bridge-Client\r\n"
      "Access-Control-Expose-Headers: Content-Disposition, Retry-After\r\n"
      "Access-Control-Max-Age: 600\r\n"
      "Connection: close\r\n"
      "Content-Length: 0\r\n\r\n";
  (void)local_write_all(fd, (const uint8_t *)response, sizeof(response) - 1);
}

static void relay(int local, int remote) {
  uint8_t to_remote[16384], to_local[16384];
  size_t remote_length = 0, remote_position = 0, local_length = 0, local_position = 0;
  const int flags = fcntl(local, F_GETFL, 0);
  if (flags >= 0) (void)fcntl(local, F_SETFL, flags | O_NONBLOCK);
  while (proxy_is_running()) {
    struct pollfd descriptor = { .fd = local, .events = 0, .revents = 0 };
    if (!remote_length) descriptor.events |= POLLIN;
    if (local_length) descriptor.events |= POLLOUT;
    const int ready = poll(&descriptor, 1, 20);
    if (ready < 0 && errno != EINTR) break;
    if (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) break;
    if ((descriptor.revents & POLLIN) && !remote_length) {
      const ssize_t count = recv(local, to_remote, sizeof(to_remote), 0);
      if (count == 0) break;
      if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
      if (count > 0) { remote_length = (size_t)count; remote_position = 0; }
    }
    if (remote_length) {
      const int count = bridge_lwip_tcp_write(remote, to_remote + remote_position, remote_length - remote_position);
      if (count == -1 || count == 0) break;
      if (count > 0) {
        remote_position += (size_t)count;
        if (remote_position == remote_length) { remote_length = 0; remote_position = 0; }
      }
    }
    if (!local_length) {
      const int count = bridge_lwip_tcp_read(remote, to_local, sizeof(to_local));
      if (count == -1 || count == 0) break;
      if (count > 0) { local_length = (size_t)count; local_position = 0; }
    }
    if ((descriptor.revents & POLLOUT) && local_length) {
      const ssize_t count = send(local, to_local + local_position, local_length - local_position, 0);
      if (count < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;
      if (count > 0) {
        local_position += (size_t)count;
        if (local_position == local_length) { local_length = 0; local_position = 0; }
      }
    }
  }
}

static void *handle_client(void *argument) {
  struct proxy_client *client = argument;
  const int local = client->fd;
  int remote = -1;
  struct timeval timeout = {5, 0};
  (void)setsockopt(local, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  (void)setsockopt(local, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
#ifdef SO_NOSIGPIPE
  int no_sigpipe = 1;
  (void)setsockopt(local, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
#endif

  uint8_t request[PROXY_MAX_HEADER];
  size_t received = 0, header_length = 0;
  if (read_request_headers(local, request, sizeof(request), &received, &header_length) == 0) {
    char method[32], target[PROXY_MAX_TARGET], version[16];
    const int parsed = parse_request_line(request, header_length, method, sizeof(method), target, sizeof(target), version, sizeof(version));
    /* The listener is bound to loopback and uses an ephemeral port. This
       experimental WebView transport deliberately keeps its URL ordinary so
       relative assets and WebSocket upgrades use the same local origin. */
    const int authorized = parsed == 0;
    if (authorized && strcasecmp(method, "OPTIONS") == 0) {
      send_preflight(local);
    } else if (authorized && parsed == 0) {
      uint8_t forwarded[PROXY_MAX_HEADER + PROXY_MAX_TOKEN + 256];
      int websocket = 0;
      const int forwarded_length = build_forward_request(request, header_length, forwarded, sizeof(forwarded), &websocket);
      if (forwarded_length > 0) {
        remote = bridge_lwip_tcp_open_ipv4(proxy.address, proxy.port);
        int connected = 0;
        for (int attempt = 0; remote >= 0 && attempt < 500 && proxy_is_running(); attempt++) {
          connected = bridge_lwip_tcp_connection_status(remote);
          if (connected != 0) break;
          usleep(20 * 1000);
        }
        if (connected == 1 && remote_write_all(remote, forwarded, (size_t)forwarded_length) == 0) {
          const size_t body_length = received - header_length;
          if (body_length == 0 || remote_write_all(remote, request + header_length, body_length) == 0) {
            /* Both ordinary HTTP and WebSocket upgrades are byte relays. */
            (void)websocket;
            relay(local, remote);
          }
        }
      }
    }
  }

  if (remote >= 0) bridge_lwip_tcp_close(remote);
  pthread_mutex_lock(&proxy.mutex);
  struct proxy_client **cursor = &proxy.clients;
  while (*cursor && *cursor != client) cursor = &(*cursor)->next;
  if (*cursor) *cursor = client->next;
  proxy.active--;
  pthread_cond_broadcast(&proxy.stopped);
  pthread_mutex_unlock(&proxy.mutex);
  close(local);
  free(client);
  return NULL;
}

static void *accept_clients(void *unused) {
  (void)unused;
  while (proxy_is_running()) {
    const int fd = accept(proxy.listener, NULL, NULL);
    if (fd < 0) {
      if (errno == EINTR) continue;
      break;
    }
    pthread_mutex_lock(&proxy.mutex);
    if (!proxy.running || proxy.active >= PROXY_MAX_CLIENTS) {
      close(fd);
      pthread_mutex_unlock(&proxy.mutex);
      continue;
    }
    struct proxy_client *client = calloc(1, sizeof(*client));
    if (!client) {
      close(fd);
      pthread_mutex_unlock(&proxy.mutex);
      continue;
    }
    client->fd = fd;
    client->next = proxy.clients;
    proxy.clients = client;
    proxy.active++;
    pthread_t thread;
    if (pthread_create(&thread, NULL, handle_client, client) != 0) {
      proxy.clients = client->next;
      proxy.active--;
      free(client);
      close(fd);
    } else {
      pthread_detach(thread);
    }
    pthread_mutex_unlock(&proxy.mutex);
  }
  return NULL;
}

int bridge_lwip_proxy_start(const char *address, uint16_t port, const char *token) {
  struct in_addr parsed;
  if (!address || inet_pton(AF_INET, address, &parsed) != 1 || !port ||
      !token || !*token || strlen(token) >= PROXY_MAX_TOKEN) return -1;

  pthread_mutex_lock(&proxy.mutex);
  if (proxy.running) {
    pthread_mutex_unlock(&proxy.mutex);
    return -1;
  }
  const int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    pthread_mutex_unlock(&proxy.mutex);
    return -1;
  }
  int reuse = 1;
  (void)setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  struct sockaddr_in local = {0};
  local.sin_family = AF_INET;
  local.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (bind(fd, (struct sockaddr *)&local, sizeof(local)) != 0 || listen(fd, PROXY_MAX_CLIENTS) != 0) {
    close(fd);
    pthread_mutex_unlock(&proxy.mutex);
    return -1;
  }
  socklen_t length = sizeof(local);
  if (getsockname(fd, (struct sockaddr *)&local, &length) != 0) {
    close(fd);
    pthread_mutex_unlock(&proxy.mutex);
    return -1;
  }
  strcpy(proxy.address, address);
  proxy.port = port;
  strcpy(proxy.token, token);
  proxy.listener = fd;
  proxy.running = 1;
  if (pthread_create(&proxy.accept_thread, NULL, accept_clients, NULL) != 0) {
    proxy.running = 0;
    proxy.listener = -1;
    memset(proxy.token, 0, sizeof(proxy.token));
    close(fd);
    pthread_mutex_unlock(&proxy.mutex);
    return -1;
  }
  pthread_mutex_unlock(&proxy.mutex);
  return (int)ntohs(local.sin_port);
}

void bridge_lwip_proxy_stop(void) {
  pthread_mutex_lock(&proxy.mutex);
  if (!proxy.running) {
    pthread_mutex_unlock(&proxy.mutex);
    return;
  }
  proxy.running = 0;
  shutdown(proxy.listener, SHUT_RDWR);
  close(proxy.listener);
  for (struct proxy_client *client = proxy.clients; client; client = client->next) {
    shutdown(client->fd, SHUT_RDWR);
  }
  pthread_mutex_unlock(&proxy.mutex);
  pthread_join(proxy.accept_thread, NULL);
  pthread_mutex_lock(&proxy.mutex);
  while (proxy.active > 0) pthread_cond_wait(&proxy.stopped, &proxy.mutex);
  proxy.listener = -1;
  memset(proxy.address, 0, sizeof(proxy.address));
  memset(proxy.token, 0, sizeof(proxy.token));
  proxy.port = 0;
  pthread_mutex_unlock(&proxy.mutex);
}
