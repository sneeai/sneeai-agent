import assert from "node:assert/strict";
import test from "node:test";

import { redactSensitiveText } from "./logger.js";

test("redactSensitiveText removes URL and proxy credentials", () => {
    const output = redactSensitiveText([
        "proxy=http://proxy-user:proxy-password@127.0.0.1:7897",
        "fallback=http://proxy-user:p@ssword@127.0.0.1:8080",
        "target=https://encoded%40user:encoded%2Fpassword@example.com/path",
    ].join(" "));

    assert.equal(output.includes("proxy-user"), false);
    assert.equal(output.includes("proxy-password"), false);
    assert.equal(output.includes("p@ssword"), false);
    assert.equal(output.includes("encoded%40user"), false);
    assert.equal(output.includes("encoded%2Fpassword"), false);
    assert.match(output, /http:\/\/\[REDACTED\]@127\.0\.0\.1:7897/);
});

test("redactSensitiveText removes API keys, bearer credentials and long tokens", () => {
    const secrets = [
        "Bearer abc.def_ghi-jklmnop",
        "api_key=secret-api-key-value",
        "ghp_1234567890abcdefghijklmnop",
        "github_pat_1234567890_abcdefghijklmnop",
        "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
    ];
    const output = redactSensitiveText(secrets.join(" "));

    for (const secret of secrets) assert.equal(output.includes(secret), false);
    assert.equal(output.includes("secret-api-key-value"), false);
    assert.equal(output.includes("ghp_1234567890abcdefghijklmnop"), false);
    assert.equal(output.includes("eyJabcdefghijk"), false);
});

test("redactSensitiveText keeps non-sensitive network context", () => {
    const output = redactSensitiveText("proxy=http://127.0.0.1:7897 code=proxy_connect_502");
    assert.equal(output, "proxy=http://127.0.0.1:7897 code=proxy_connect_502");
});
