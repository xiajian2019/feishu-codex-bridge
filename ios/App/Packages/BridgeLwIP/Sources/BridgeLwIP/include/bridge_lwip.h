#ifndef BRIDGE_LWIP_H
#define BRIDGE_LWIP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef void (*bridge_lwip_packet_output_fn)(const uint8_t *packet, size_t length, void *context);

typedef struct bridge_lwip_config {
  const char *local_address;
  const char *address_mask;
  const char *gateway_address;
  uint16_t mtu;
} bridge_lwip_config;

int bridge_lwip_start(const bridge_lwip_config *config,
                      bridge_lwip_packet_output_fn output,
                      void *context);

/* Inject a decrypted IP packet received from the OpenVPN data channel. */
int bridge_lwip_input_packet(const uint8_t *packet, size_t length);

/* Run a small plain-HTTP probe through lwIP's socket API. */
int bridge_lwip_http_probe_ipv4(const char *address,
                                uint16_t port,
                                const uint8_t *request,
                                size_t request_length,
                                uint8_t *response,
                                size_t response_capacity,
                                uint32_t timeout_ms);

/* Nonblocking IPv4 TCP stream, owned and used by one thread. */
int bridge_lwip_tcp_open_ipv4(const char *address, uint16_t port);
int bridge_lwip_tcp_connection_status(int socket_fd);
int bridge_lwip_tcp_read(int socket_fd, uint8_t *bytes, size_t capacity);
int bridge_lwip_tcp_write(int socket_fd, const uint8_t *bytes, size_t length);
void bridge_lwip_tcp_close(int socket_fd);

/* A loopback-only HTTP/WebSocket reverse proxy restricted to one IPv4 target. */
int bridge_lwip_proxy_start(const char *address, uint16_t port, const char *token);
void bridge_lwip_proxy_stop(void);

void bridge_lwip_stop(void);
const char *bridge_lwip_last_error(void);

#ifdef __cplusplus
}
#endif

#endif
