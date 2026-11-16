// Test-only stubs for the optional SLIP serial driver; the fixture uses an IP netif.
#include <stdint.h>
#include <stddef.h>
void *sio_open(uint8_t device) { (void)device; return NULL; }
void sio_send(uint8_t byte, void *descriptor) { (void)byte; (void)descriptor; }
uint32_t sio_read(void *descriptor, uint8_t *data, uint32_t length) { (void)descriptor; (void)data; (void)length; return 0; }
uint32_t sio_tryread(void *descriptor, uint8_t *data, uint32_t length) { (void)descriptor; (void)data; (void)length; return 0; }
