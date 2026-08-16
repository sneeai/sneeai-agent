import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";

const KEYCHAIN_SERVICE = "com.sneeai.agent.connect-token";
const REFERENCE_VERSION = 1;

export type CredentialReference = {
    version: 1;
    backend: "macos-keychain";
    ownerId: string;
    account: string;
} | {
    version: 1;
    backend: "windows-dpapi";
    ownerId: string;
    protectedValue: string;
};

export type CredentialCommandRunner = (
    executable: string,
    args: readonly string[],
    options: { input?: string },
) => string;

export type CredentialStoreOptions = {
    platform?: NodeJS.Platform;
    userIdentity?: string;
    run?: CredentialCommandRunner;
    randomId?: () => string;
};

export class CredentialStoreError extends Error {
    constructor(readonly code: string, readonly backend: CredentialReference["backend"] | "unsupported") {
        super(`Sneeai Agent credential operation failed (${code})`);
        this.name = "CredentialStoreError";
    }
}

export type CredentialStore = ReturnType<typeof createCredentialStore>;

/** Creates a current-user credential store. Secrets are passed over stdin, never argv. */
export function createCredentialStore(options: CredentialStoreOptions = {}) {
    const platform = options.platform || process.platform;
    const ownerId = credentialOwnerId(options.userIdentity || systemUserIdentity());
    const run = options.run || runCredentialCommand;
    const randomId = options.randomId || (() => crypto.randomBytes(16).toString("hex"));

    return {
        backend: platform === "darwin" ? "macos-keychain" as const : platform === "win32" ? "windows-dpapi" as const : "unsupported" as const,
        ownerId,
        store(value: string): CredentialReference {
            assertCredential(value);
            if (platform === "darwin") {
                const account = `connect-token-${ownerId}-${safeCredentialId(randomId())}`;
                try {
                    run("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { input: `${value}\n` });
                } catch {
                    throw new CredentialStoreError("credential_store_write_failed", "macos-keychain");
                }
                return { version: REFERENCE_VERSION, backend: "macos-keychain", ownerId, account };
            }
            if (platform === "win32") {
                let protectedValue: string;
                try {
                    protectedValue = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsProtectScript()], { input: value }).trim();
                } catch {
                    throw new CredentialStoreError("credential_store_write_failed", "windows-dpapi");
                }
                if (!/^[A-Za-z0-9+/]+={0,2}$/.test(protectedValue)) throw new CredentialStoreError("credential_store_response_invalid", "windows-dpapi");
                return { version: REFERENCE_VERSION, backend: "windows-dpapi", ownerId, protectedValue };
            }
            throw new CredentialStoreError("credential_store_unsupported", "unsupported");
        },
        read(reference: CredentialReference): string {
            validateCredentialReference(reference);
            if (reference.ownerId !== ownerId) throw new CredentialStoreError("credential_owner_mismatch", reference.backend);
            if (reference.backend === "macos-keychain") {
                if (platform !== "darwin") throw new CredentialStoreError("credential_backend_unavailable", reference.backend);
                try {
                    const value = run("/usr/bin/security", ["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", reference.account], {}).replace(/\r?\n$/, "");
                    assertCredential(value, reference.backend);
                    return value;
                } catch (error) {
                    if (error instanceof CredentialStoreError) throw error;
                    throw new CredentialStoreError("credential_store_read_failed", reference.backend);
                }
            }
            if (platform !== "win32") throw new CredentialStoreError("credential_backend_unavailable", reference.backend);
            try {
                const value = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsUnprotectScript()], { input: reference.protectedValue });
                assertCredential(value, reference.backend);
                return value;
            } catch (error) {
                if (error instanceof CredentialStoreError) throw error;
                throw new CredentialStoreError("credential_store_read_failed", reference.backend);
            }
        },
        remove(reference: CredentialReference): void {
            validateCredentialReference(reference);
            if (reference.ownerId !== ownerId) throw new CredentialStoreError("credential_owner_mismatch", reference.backend);
            if (reference.backend === "windows-dpapi") return;
            if (platform !== "darwin") throw new CredentialStoreError("credential_backend_unavailable", reference.backend);
            try {
                run("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", reference.account], {});
            } catch {
                throw new CredentialStoreError("credential_store_delete_failed", reference.backend);
            }
        },
    };
}

export function isCredentialReference(value: unknown): value is CredentialReference {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const reference = value as Partial<CredentialReference>;
    if (reference.version !== REFERENCE_VERSION || typeof reference.ownerId !== "string" || !/^[a-f0-9]{32}$/.test(reference.ownerId)) return false;
    if (reference.backend === "macos-keychain") return typeof reference.account === "string" && /^connect-token-[a-f0-9]{32}-[A-Za-z0-9_-]{8,128}$/.test(reference.account);
    return reference.backend === "windows-dpapi" && typeof reference.protectedValue === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(reference.protectedValue);
}

export function credentialOwnerId(userIdentity: string) {
    if (!userIdentity.trim()) throw new CredentialStoreError("credential_owner_invalid", "unsupported");
    return crypto.createHash("sha256").update(`sneeai-agent-user-v1\0${userIdentity}`).digest("hex").slice(0, 32);
}

function systemUserIdentity() {
    const user = os.userInfo();
    return `${user.uid}:${user.username}:${user.homedir}`;
}

function validateCredentialReference(reference: CredentialReference) {
    if (!isCredentialReference(reference)) throw new CredentialStoreError("credential_reference_invalid", "unsupported");
}

function assertCredential(value: string, backend: CredentialReference["backend"] | "unsupported" = "unsupported") {
    if (typeof value !== "string" || value.length < 16 || value.length > 4_096 || /[\r\n\0]/.test(value)) {
        throw new CredentialStoreError("credential_value_invalid", backend);
    }
}

function safeCredentialId(value: string) {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new CredentialStoreError("credential_id_invalid", "macos-keychain");
    return value;
}

function runCredentialCommand(executable: string, args: readonly string[], options: { input?: string }) {
    return execFileSync(executable, [...args], {
        encoding: "utf8",
        input: options.input,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
    });
}

function windowsProtectScript() {
    return [
        "$ErrorActionPreference='Stop'",
        "$value=[Console]::In.ReadToEnd()",
        "$bytes=[Text.Encoding]::UTF8.GetBytes($value)",
        "$protected=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Convert]::ToBase64String($protected))",
    ].join(";");
}

function windowsUnprotectScript() {
    return [
        "$ErrorActionPreference='Stop'",
        "$value=[Console]::In.ReadToEnd()",
        "$protected=[Convert]::FromBase64String($value)",
        "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($protected,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
        "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))",
    ].join(";");
}
