package dev.feishu.codex.bridge;

import com.google.crypto.tink.subtle.Ed25519Sign;
import com.google.crypto.tink.subtle.Ed25519Verify;
import java.io.ByteArrayOutputStream;
import java.security.GeneralSecurityException;
import java.security.InvalidKeyException;
import java.security.InvalidParameterException;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SignatureException;
import java.security.SignatureSpi;
import java.util.Arrays;

/** JCA adapter for the Tink Ed25519 implementation already used by cbssh. */
public final class BridgeEd25519Signature extends SignatureSpi {
    private final ClearableBuffer message = new ClearableBuffer();
    private Ed25519Sign signer;
    private Ed25519Verify verifier;

    @Override
    protected void engineInitSign(PrivateKey privateKey) throws InvalidKeyException {
        resetState();
        byte[] encoded = privateKey.getEncoded();
        if (encoded == null) throw new InvalidKeyException("Ed25519 private key is not exportable");
        byte[] seed = null;
        try {
            seed = BridgeEd25519Der.decodePrivateKey(encoded);
            signer = new Ed25519Sign(seed);
        } catch (Exception e) {
            throw new InvalidKeyException("Invalid Ed25519 private key", e);
        } finally {
            Arrays.fill(encoded, (byte) 0);
            if (seed != null) Arrays.fill(seed, (byte) 0);
        }
    }

    @Override
    protected void engineInitVerify(PublicKey publicKey) throws InvalidKeyException {
        resetState();
        byte[] encoded = publicKey.getEncoded();
        if (encoded == null) throw new InvalidKeyException("Ed25519 public key is not exportable");
        try {
            byte[] raw = BridgeEd25519Der.decodePublicKey(encoded);
            verifier = new Ed25519Verify(raw);
        } catch (Exception e) {
            throw new InvalidKeyException("Invalid Ed25519 public key", e);
        }
    }

    @Override
    protected void engineUpdate(byte value) {
        message.write(value);
    }

    @Override
    protected void engineUpdate(byte[] value, int offset, int length) {
        message.write(value, offset, length);
    }

    @Override
    protected byte[] engineSign() throws SignatureException {
        byte[] bytes = message.toByteArray();
        try {
            return signer.sign(bytes);
        } catch (GeneralSecurityException e) {
            throw new SignatureException("Ed25519 signing failed", e);
        } finally {
            Arrays.fill(bytes, (byte) 0);
            message.clear();
        }
    }

    @Override
    protected boolean engineVerify(byte[] signature) {
        byte[] bytes = message.toByteArray();
        try {
            verifier.verify(signature, bytes);
            return true;
        } catch (GeneralSecurityException e) {
            return false;
        } finally {
            Arrays.fill(bytes, (byte) 0);
            message.clear();
        }
    }

    @Override
    @Deprecated
    protected void engineSetParameter(String name, Object value) throws InvalidParameterException {
        throw new InvalidParameterException("Ed25519 does not support parameters");
    }

    @Override
    @Deprecated
    protected Object engineGetParameter(String name) throws InvalidParameterException {
        throw new InvalidParameterException("Ed25519 does not support parameters");
    }

    private void resetState() {
        signer = null;
        verifier = null;
        message.clear();
    }

    private static final class ClearableBuffer extends ByteArrayOutputStream {
        void clear() {
            Arrays.fill(buf, 0, count, (byte) 0);
            reset();
        }
    }
}
