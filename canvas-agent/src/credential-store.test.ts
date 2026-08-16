import assert from "node:assert/strict";
import test from "node:test";

import { createCredentialStore, CredentialStoreError, credentialOwnerId } from "./credential-store.js";

const TOKEN = "0123456789abcdef0123456789abcdef";

test("macOS Keychain stores secrets over stdin and isolates system users", () => {
    const calls: Array<{ executable: string; args: readonly string[]; input?: string }> = [];
    const run = (executable: string, args: readonly string[], options: { input?: string }) => {
        calls.push({ executable, args, input: options.input });
        return args.includes("find-generic-password") ? `${TOKEN}\n` : "";
    };
    const store = createCredentialStore({ platform: "darwin", userIdentity: "501:alice:/Users/alice", randomId: () => "credential01", run });
    const reference = store.store(TOKEN);

    assert.equal(reference.backend, "macos-keychain");
    assert.equal(JSON.stringify(reference).includes(TOKEN), false);
    assert.equal(calls[0]?.args.join(" ").includes(TOKEN), false);
    assert.equal(calls[0]?.input, `${TOKEN}\n`);
    assert.equal(store.read(reference), TOKEN);
    store.remove(reference);
    assert.equal(calls.at(-1)?.args.includes("delete-generic-password"), true);

    const otherUser = createCredentialStore({ platform: "darwin", userIdentity: "502:bob:/Users/bob", run });
    assert.throws(() => otherUser.read(reference), (error: unknown) => error instanceof CredentialStoreError && error.code === "credential_owner_mismatch");
    assert.notEqual(store.ownerId, otherUser.ownerId);
});

test("Windows DPAPI uses CurrentUser and keeps plaintext out of argv", () => {
    const protectedValue = Buffer.from("dpapi-fixture").toString("base64");
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const run = (_executable: string, args: readonly string[], options: { input?: string }) => {
        calls.push({ args, input: options.input });
        return options.input === TOKEN ? protectedValue : TOKEN;
    };
    const store = createCredentialStore({ platform: "win32", userIdentity: "1001:alice:C:\\Users\\alice", run });
    const reference = store.store(TOKEN);

    assert.equal(reference.backend, "windows-dpapi");
    assert.equal(calls[0]?.args.join(" ").includes("DataProtectionScope]::CurrentUser"), true);
    assert.equal(calls[0]?.args.join(" ").includes(TOKEN), false);
    assert.equal(store.read(reference), TOKEN);
    assert.equal(calls[1]?.args.join(" ").includes("DataProtectionScope]::CurrentUser"), true);
    store.remove(reference);
    assert.equal(calls.length, 2);
});

test("credential failures expose stable diagnostics without secret values", () => {
    const store = createCredentialStore({
        platform: "darwin",
        userIdentity: "501:alice:/Users/alice",
        randomId: () => "credential01",
        run: () => { throw new Error(`failed for ${TOKEN}`); },
    });
    assert.throws(() => store.store(TOKEN), (error: unknown) => {
        assert.ok(error instanceof CredentialStoreError);
        assert.equal(error.code, "credential_store_write_failed");
        assert.equal(error.message.includes(TOKEN), false);
        return true;
    });
});

test("owner identifiers are stable but distinct", () => {
    assert.equal(credentialOwnerId("501:alice:/Users/alice"), credentialOwnerId("501:alice:/Users/alice"));
    assert.notEqual(credentialOwnerId("501:alice:/Users/alice"), credentialOwnerId("502:bob:/Users/bob"));
});
