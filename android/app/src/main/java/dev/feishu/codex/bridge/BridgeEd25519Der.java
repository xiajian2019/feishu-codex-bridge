package dev.feishu.codex.bridge;

import java.math.BigInteger;
import java.util.Arrays;
import kotlin.Unit;
import org.connectbot.sshlib.crypto.DerReader;
import org.connectbot.sshlib.crypto.DerWriter;

/**
 * RFC 8410 Ed25519 key encodings using cbssh 0.5.0's bounded DER reader and writer.
 * cbssh does not expose these helpers as public Kotlin API; verify this adapter
 * and the legacy-key tests when upgrading the pinned cbssh dependency.
 */
final class BridgeEd25519Der {
    private static final byte[] ED25519_OID = {0x2b, 0x65, 0x70};
    private static final int KEY_SIZE = 32;

    private BridgeEd25519Der() {}

    static byte[] encodePrivateKey(byte[] seed) {
        if (seed.length != KEY_SIZE) throw new IllegalArgumentException("Invalid Ed25519 seed length");
        DerWriter inner = new DerWriter();
        inner.octetString(seed);
        byte[] wrappedSeed = inner.toByteArray();
        try {
            DerWriter output = new DerWriter();
            output.sequence(sequence -> {
                sequence.integer(BigInteger.ZERO);
                sequence.sequence(algorithm -> {
                    algorithm.objectIdentifier(ED25519_OID);
                    return Unit.INSTANCE;
                });
                sequence.octetString(wrappedSeed);
                return Unit.INSTANCE;
            });
            return output.toByteArray();
        } finally {
            Arrays.fill(wrappedSeed, (byte) 0);
        }
    }

    static byte[] decodePrivateKey(byte[] encoded) {
        DerReader input = new DerReader(encoded);
        byte[] seed = null;
        try {
            seed = input.readSequence(sequence -> {
                BigInteger version = sequence.readInteger();
                if (!BigInteger.ZERO.equals(version) && !BigInteger.ONE.equals(version)) {
                    throw new IllegalArgumentException("Unsupported Ed25519 private key version");
                }
                readAlgorithm(sequence);
                byte[] wrappedSeed = sequence.readOctetString();
                byte[] decoded = null;
                try {
                    DerReader inner = new DerReader(wrappedSeed);
                    decoded = inner.readOctetString();
                    inner.ensureFullyConsumed();
                    if (decoded.length != KEY_SIZE) throw new IllegalArgumentException("Invalid Ed25519 seed length");
                    // PKCS#8 attributes and RFC 5958's optional public key.
                    if (sequence.peekTag() == 0xa0) sequence.skipTag();
                    if (sequence.peekTag() == 0x81) {
                        if (!BigInteger.ONE.equals(version)) {
                            throw new IllegalArgumentException("Unexpected Ed25519 public key");
                        }
                        sequence.skipTag();
                    }
                    if (sequence.hasRemaining()) throw new IllegalArgumentException("Unexpected Ed25519 private key field");
                    return decoded;
                } catch (Exception e) {
                    if (decoded != null) Arrays.fill(decoded, (byte) 0);
                    throw new IllegalArgumentException("Invalid Ed25519 private key", e);
                } finally {
                    Arrays.fill(wrappedSeed, (byte) 0);
                }
            });
            input.ensureFullyConsumed();
            return seed;
        } catch (Exception e) {
            if (seed != null) Arrays.fill(seed, (byte) 0);
            throw new IllegalArgumentException("Invalid Ed25519 private key", e);
        }
    }

    static byte[] decodePublicKey(byte[] encoded) {
        DerReader input = new DerReader(encoded);
        byte[] raw = input.readSequence(sequence -> {
            readAlgorithm(sequence);
            byte[] key = sequence.readBitString();
            if (key.length != KEY_SIZE) throw new IllegalArgumentException("Invalid Ed25519 public key length");
            return key;
        });
        input.ensureFullyConsumed();
        return raw;
    }

    private static void readAlgorithm(DerReader sequence) {
        sequence.readSequence(algorithm -> {
            if (!Arrays.equals(ED25519_OID, algorithm.readObjectIdentifier())) {
                throw new IllegalArgumentException("Not an Ed25519 key");
            }
            // Match the previous ASN.1 reader for encoded algorithm parameters.
            if (algorithm.hasRemaining()) algorithm.skipTag();
            return Unit.INSTANCE;
        });
    }
}
