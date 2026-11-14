#include "bridge_lwip.h"

#include <errno.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "lwip/err.h"
#include "lwip/inet.h"
#include "lwip/ip4.h"
#if LWIP_IPV6
#include "lwip/ip6.h"
#endif
#include "lwip/netif.h"
#include "lwip/netifapi.h"
#include "lwip/pbuf.h"
#include "lwip/sockets.h"
#include "lwip/tcpip.h"

struct bridge_lwip_state {
  pthread_mutex_t mutex;
  pthread_cond_t initialized_condition;
  struct netif netif;
  bridge_lwip_packet_output_fn output;
  void *context;
  char last_error[256];
  char local_address[64];
  char address_mask[64];
  char gateway_address[64];
  uint16_t mtu;
  int started;
  int ready;
  int tcpip_initialized;
  int initialization_done;
  int assertion_failed;
};

static struct bridge_lwip_state bridge_state = {
  .mutex = PTHREAD_MUTEX_INITIALIZER,
  .initialized_condition = PTHREAD_COND_INITIALIZER,
  .mtu = 1400,
};

void lwip_example_app_platform_assert(const char *message, int line, const char *file) {
  pthread_mutex_lock(&bridge_state.mutex);
  snprintf(bridge_state.last_error, sizeof(bridge_state.last_error),
           "lwIP assertion at %s:%d: %s", file, line, message ? message : "unknown");
  bridge_state.assertion_failed = 1;
  bridge_state.ready = 0;
  pthread_mutex_unlock(&bridge_state.mutex);
}

static void set_error(const char *message) {
  pthread_mutex_lock(&bridge_state.mutex);
  snprintf(bridge_state.last_error, sizeof(bridge_state.last_error), "%s", message ? message : "unknown error");
  pthread_mutex_unlock(&bridge_state.mutex);
}

static void set_errno_error(const char *operation) {
  pthread_mutex_lock(&bridge_state.mutex);
  snprintf(bridge_state.last_error, sizeof(bridge_state.last_error), "%s: %s", operation, strerror(errno));
  pthread_mutex_unlock(&bridge_state.mutex);
}

static err_t bridge_link_output(struct netif *netif, struct pbuf *packet) {
  (void)netif;
  if (!bridge_state.output || !packet || packet->tot_len == 0) {
    return ERR_IF;
  }

  uint8_t *bytes = (uint8_t *)malloc(packet->tot_len);
  if (!bytes) {
    return ERR_MEM;
  }
  const u16_t copied = pbuf_copy_partial(packet, bytes, packet->tot_len, 0);
  if (copied != packet->tot_len) {
    free(bytes);
    return ERR_IF;
  }
  bridge_state.output(bytes, packet->tot_len, bridge_state.context);
  free(bytes);
  return ERR_OK;
}

static err_t bridge_output_ipv4(struct netif *netif, struct pbuf *packet, const ip4_addr_t *ipaddr) {
  (void)ipaddr;
  return bridge_link_output(netif, packet);
}

#if LWIP_IPV6
static err_t bridge_output_ipv6(struct netif *netif, struct pbuf *packet, const ip6_addr_t *ipaddr) {
  (void)ipaddr;
  return bridge_link_output(netif, packet);
}
#endif

static err_t bridge_netif_init(struct netif *netif) {
  netif->name[0] = 'b';
  netif->name[1] = 'v';
  netif->output = bridge_output_ipv4;
#if LWIP_IPV6
  netif->output_ip6 = bridge_output_ipv6;
#endif
  netif->linkoutput = bridge_link_output;
  netif->mtu = bridge_state.mtu;
  netif->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_IGMP;
  return ERR_OK;
}

static void bridge_configure_netif(void *argument) {
  (void)argument;
  ip4_addr_t address;
  ip4_addr_t mask;
  ip4_addr_t gateway;
  ip4addr_aton(bridge_state.local_address, &address);
  ip4addr_aton(bridge_state.address_mask, &mask);
  ip4addr_aton(bridge_state.gateway_address, &gateway);

  if (!netif_add(&bridge_state.netif, &address, &mask, &gateway, NULL, bridge_netif_init, tcpip_input)) {
    set_error("lwIP netif_add failed");
    pthread_mutex_lock(&bridge_state.mutex);
    bridge_state.initialization_done = 1;
    pthread_cond_signal(&bridge_state.initialized_condition);
    pthread_mutex_unlock(&bridge_state.mutex);
    return;
  }
  netif_set_default(&bridge_state.netif);
  netif_set_up(&bridge_state.netif);
  netif_set_link_up(&bridge_state.netif);
  pthread_mutex_lock(&bridge_state.mutex);
  if (!bridge_state.assertion_failed) {
    bridge_state.ready = 1;
  }
  bridge_state.initialization_done = 1;
  pthread_cond_signal(&bridge_state.initialized_condition);
  pthread_mutex_unlock(&bridge_state.mutex);
}

int bridge_lwip_start(const bridge_lwip_config *config,
                      bridge_lwip_packet_output_fn output,
                      void *context) {
  if (!config || !config->local_address || !config->address_mask || !config->gateway_address || !output) {
    set_error("invalid lwIP configuration");
    return -1;
  }

  pthread_mutex_lock(&bridge_state.mutex);
  if (bridge_state.started) {
    pthread_mutex_unlock(&bridge_state.mutex);
    return bridge_state.ready ? 0 : -1;
  }
  snprintf(bridge_state.local_address, sizeof(bridge_state.local_address), "%s", config->local_address);
  snprintf(bridge_state.address_mask, sizeof(bridge_state.address_mask), "%s", config->address_mask);
  snprintf(bridge_state.gateway_address, sizeof(bridge_state.gateway_address), "%s", config->gateway_address);
  bridge_state.mtu = config->mtu >= 576 ? config->mtu : 1400;
  bridge_state.output = output;
  bridge_state.context = context;
  bridge_state.assertion_failed = 0;
  const int needs_tcpip_init = !bridge_state.tcpip_initialized;
  bridge_state.started = 1;
  bridge_state.initialization_done = 0;
  pthread_mutex_unlock(&bridge_state.mutex);

  if (needs_tcpip_init) {
    tcpip_init(bridge_configure_netif, NULL);
    pthread_mutex_lock(&bridge_state.mutex);
    bridge_state.tcpip_initialized = 1;
    while (!bridge_state.initialization_done) {
      pthread_cond_wait(&bridge_state.initialized_condition, &bridge_state.mutex);
    }
    pthread_mutex_unlock(&bridge_state.mutex);
  } else {
    if (tcpip_callback_wait(bridge_configure_netif, NULL) != ERR_OK) {
      set_error("lwIP tcpip_callback_wait failed");
    }
  }
  pthread_mutex_lock(&bridge_state.mutex);
  const int is_ready = bridge_state.ready && !bridge_state.assertion_failed;
  if (!is_ready) {
    bridge_state.started = 0;
    bridge_state.output = NULL;
    bridge_state.context = NULL;
  }
  pthread_mutex_unlock(&bridge_state.mutex);
  return is_ready ? 0 : -1;
}

int bridge_lwip_input_packet(const uint8_t *packet, size_t length) {
  if (!bridge_state.ready || !packet || length == 0 || length > 65535) {
    set_error("lwIP is not ready or packet is invalid");
    return -1;
  }
  struct pbuf *buffer = pbuf_alloc(PBUF_RAW, (u16_t)length, PBUF_POOL);
  if (!buffer) {
    set_error("lwIP pbuf_alloc failed");
    return -1;
  }
  if (pbuf_take(buffer, packet, length) != ERR_OK) {
    pbuf_free(buffer);
    set_error("lwIP pbuf_take failed");
    return -1;
  }
  err_t result = bridge_state.netif.input(buffer, &bridge_state.netif);
  if (result != ERR_OK) {
    pbuf_free(buffer);
    set_error("lwIP netif input failed");
    return -1;
  }
  return 0;
}

static int wait_for_socket(int socket_fd, uint32_t timeout_ms) {
  struct timeval timeout;
  timeout.tv_sec = (time_t)(timeout_ms / 1000U);
  timeout.tv_usec = (suseconds_t)((timeout_ms % 1000U) * 1000U);
  if (lwip_setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0) {
    set_errno_error("setsockopt(SO_RCVTIMEO)");
    return -1;
  }
  if (lwip_setsockopt(socket_fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) < 0) {
    /* Some older/trimmed lwIP builds do not expose a send timeout. The probe
       request is bounded and small; keep the receive timeout and continue in
       that configuration instead of failing before connect(). */
    const int error = errno;
    if (error != ENOPROTOOPT && error != EOPNOTSUPP) {
      set_errno_error("setsockopt(SO_SNDTIMEO)");
      return -1;
    }
  }
  return 0;
}

int bridge_lwip_http_probe_ipv4(const char *address,
                                uint16_t port,
                                const uint8_t *request,
                                size_t request_length,
                                uint8_t *response,
                                size_t response_capacity,
                                uint32_t timeout_ms) {
  if (!bridge_state.ready || !address || !request || request_length == 0 || !response || response_capacity == 0) {
    set_error("invalid HTTP probe arguments or lwIP is not ready");
    return -1;
  }
  int socket_fd = lwip_socket(AF_INET, SOCK_STREAM, 0);
  if (socket_fd < 0) {
    set_errno_error("socket");
    return -1;
  }
  if (wait_for_socket(socket_fd, timeout_ms) != 0) {
    lwip_close(socket_fd);
    return -1;
  }
  struct sockaddr_in endpoint;
  memset(&endpoint, 0, sizeof(endpoint));
  endpoint.sin_family = AF_INET;
  endpoint.sin_port = lwip_htons(port);
  if (lwip_inet_pton(AF_INET, address, &endpoint.sin_addr) != 1) {
    set_error("HTTP probe address is not an IPv4 literal");
    lwip_close(socket_fd);
    return -1;
  }
  if (lwip_connect(socket_fd, (struct sockaddr *)&endpoint, sizeof(endpoint)) < 0) {
    set_errno_error("connect");
    lwip_close(socket_fd);
    return -1;
  }

  size_t sent = 0;
  while (sent < request_length) {
    const ssize_t result = lwip_send(socket_fd, request + sent, request_length - sent, 0);
    if (result <= 0) {
      set_errno_error("send");
      lwip_close(socket_fd);
      return -1;
    }
    sent += (size_t)result;
  }

  size_t received = 0;
  while (received < response_capacity) {
    const ssize_t result = lwip_recv(socket_fd, response + received, response_capacity - received, 0);
    if (result == 0) {
      break;
    }
    if (result < 0) {
      set_errno_error("recv");
      lwip_close(socket_fd);
      return -1;
    }
    received += (size_t)result;
  }
  lwip_close(socket_fd);
  return (int)received;
}

int bridge_lwip_tcp_open_ipv4(const char *address, uint16_t port) {
  if (!bridge_state.ready || !address || !port) return -1;
  int fd = lwip_socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  if (lwip_fcntl(fd, F_SETFL, O_NONBLOCK) < 0) { lwip_close(fd); return -1; }
  struct sockaddr_in target;
  memset(&target, 0, sizeof(target));
  target.sin_family = AF_INET;
  target.sin_port = lwip_htons(port);
  if (lwip_inet_pton(AF_INET, address, &target.sin_addr) != 1) { lwip_close(fd); return -1; }
  if (lwip_connect(fd, (struct sockaddr *)&target, sizeof(target)) < 0 && errno != EINPROGRESS) {
    lwip_close(fd);
    return -1;
  }
  return fd;
}

int bridge_lwip_tcp_connection_status(int fd) {
  fd_set writable, failed;
  FD_ZERO(&writable); FD_ZERO(&failed);
  FD_SET(fd, &writable); FD_SET(fd, &failed);
  struct timeval timeout = {0, 0};
  int selected = lwip_select(fd + 1, NULL, &writable, &failed, &timeout);
  if (selected < 0 || FD_ISSET(fd, &failed)) return -1;
  if (!FD_ISSET(fd, &writable)) return 0;
  int error = 0; socklen_t length = sizeof(error);
  if (lwip_getsockopt(fd, SOL_SOCKET, SO_ERROR, &error, &length) < 0 || error) return -1;
  return 1;
}

int bridge_lwip_tcp_read(int fd, uint8_t *bytes, size_t capacity) {
  int result = (int)lwip_recv(fd, bytes, capacity, 0);
  return result < 0 && (errno == EWOULDBLOCK || errno == EAGAIN) ? -2 : result;
}

int bridge_lwip_tcp_write(int fd, const uint8_t *bytes, size_t length) {
  int result = (int)lwip_send(fd, bytes, length, 0);
  return result < 0 && (errno == EWOULDBLOCK || errno == EAGAIN) ? -2 : result;
}

void bridge_lwip_tcp_close(int fd) { if (fd >= 0) lwip_close(fd); }

void bridge_lwip_stop(void) {
  bridge_lwip_proxy_stop();
  if (!bridge_state.started) {
    return;
  }
  if (bridge_state.ready) {
    netifapi_netif_remove(&bridge_state.netif);
  }
  bridge_state.ready = 0;
  bridge_state.started = 0;
  bridge_state.assertion_failed = 0;
  bridge_state.output = NULL;
  bridge_state.context = NULL;
}

const char *bridge_lwip_last_error(void) {
  return bridge_state.last_error;
}
