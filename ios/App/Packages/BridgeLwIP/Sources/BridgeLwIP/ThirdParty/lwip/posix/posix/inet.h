#ifndef BRIDGE_LWIP_POSIX_INET_H
#define BRIDGE_LWIP_POSIX_INET_H

/*
 * The normal lwIP unix POSIX header includes Apple's netinet/in.h. That
 * header declares Darwin's IPv6 packet structs, which collide with lwIP's
 * protocol structs when this target is compiled as a C module. The POC is
 * deliberately IPv4-only, so keep the adapter's POSIX surface minimal.
 */
#include <stdint.h>
#include <sys/socket.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t in_addr_t;

struct in_addr {
  in_addr_t s_addr;
};

struct sockaddr_in {
  uint8_t sin_len;
  sa_family_t sin_family;
  in_port_t sin_port;
  struct in_addr sin_addr;
  char sin_zero[8];
};

#ifdef __cplusplus
}
#endif

#endif
