/*
 * Android crypto adapter for LibVNCClient.
 *
 * The LibVNC included backend deliberately implements only DES-based VNC
 * authentication. Apple Screen Sharing uses ARD authentication, which needs
 * MD5, AES-128-ECB, Diffie-Hellman and secure random bytes. The JNI bridge
 * implements those operations with Android's standard crypto providers while
 * the RFB socket and framebuffer remain native/direct TCP.
 */

#include <string.h>
#include "d3des.h"
#include "crypto.h"

extern int bridge_android_hash_md5(void *out, const void *in, size_t in_len);
extern void bridge_android_random_bytes(void *out, size_t len);
extern int bridge_android_encrypt_aes128ecb(void *out, int *out_len,
                                            const unsigned char key[16],
                                            const void *in, size_t in_len);
extern int bridge_android_dh_generate_keypair(uint8_t *priv_out, uint8_t *pub_out,
                                              const uint8_t *gen, size_t gen_len,
                                              const uint8_t *prime, size_t key_len);
extern int bridge_android_dh_compute_shared_key(uint8_t *shared_out,
                                                const uint8_t *priv,
                                                const uint8_t *pub,
                                                const uint8_t *prime,
                                                size_t key_len);

int hash_md5(void *out, const void *in, const size_t in_len) {
    return bridge_android_hash_md5(out, in, in_len);
}

void random_bytes(void *out, size_t len) {
    bridge_android_random_bytes(out, len);
}

static unsigned char reverseByte(unsigned char b) {
    b = (unsigned char)(((b & 0xF0) >> 4) | ((b & 0x0F) << 4));
    b = (unsigned char)(((b & 0xCC) >> 2) | ((b & 0x33) << 2));
    b = (unsigned char)(((b & 0xAA) >> 1) | ((b & 0x55) << 1));
    return b;
}

int encrypt_rfbdes(void *out, int *out_len, const unsigned char key[8],
                   const void *in, const size_t in_len) {
    unsigned char munged_key[8];
    const int blocks = (int)(in_len / 8);
    int i;
    for (i = 0; i < 8; ++i) munged_key[i] = reverseByte(key[i]);
    rfbDesKey(munged_key, EN0);
    for (i = 0; i < blocks; ++i) {
        rfbDes((unsigned char *)in + i * 8, (unsigned char *)out + i * 8);
    }
    *out_len = blocks * 8;
    return 1;
}

int decrypt_rfbdes(void *out, int *out_len, const unsigned char key[8],
                   const void *in, const size_t in_len) {
    unsigned char munged_key[8];
    const int blocks = (int)(in_len / 8);
    int i;
    for (i = 0; i < 8; ++i) munged_key[i] = reverseByte(key[i]);
    rfbDesKey(munged_key, DE1);
    for (i = 0; i < blocks; ++i) {
        rfbDes((unsigned char *)in + i * 8, (unsigned char *)out + i * 8);
    }
    *out_len = blocks * 8;
    return 1;
}

int encrypt_aes128ecb(void *out, int *out_len, const unsigned char key[16],
                      const void *in, const size_t in_len) {
    return bridge_android_encrypt_aes128ecb(out, out_len, key, in, in_len);
}

int dh_generate_keypair(uint8_t *priv_out, uint8_t *pub_out,
                        const uint8_t *gen, const size_t gen_len,
                        const uint8_t *prime, const size_t key_len) {
    return bridge_android_dh_generate_keypair(priv_out, pub_out, gen, gen_len, prime, key_len);
}

int dh_compute_shared_key(uint8_t *shared_out, const uint8_t *priv,
                          const uint8_t *pub, const uint8_t *prime,
                          const size_t key_len) {
    return bridge_android_dh_compute_shared_key(shared_out, priv, pub, prime, key_len);
}
