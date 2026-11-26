import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { resolveSsl } from "./databaseSsl.js";

const PEMS = {
  root: "-----BEGIN CERTIFICATE-----\nroot\n-----END CERTIFICATE-----\n",
};

const remote = "postgres://ops:ops@db.example.com:5432/opspilot";
const loopback = "postgres://ops:ops@127.0.0.1:5432/opspilot";

describe("resolveSsl", () => {
  it("turns TLS off for a loopback host, so a local Postgres works", () => {
    assert.equal(resolveSsl({ connectionString: loopback }), undefined);
    assert.equal(
      resolveSsl({ connectionString: "postgres://ops:ops@localhost/opspilot" }),
      undefined
    );
  });

  it("uses unverified TLS for a remote host without a CA", () => {
    assert.deepEqual(resolveSsl({ connectionString: remote }), {
      rejectUnauthorized: false,
    });
  });

  it("verifies the certificate when DATABASE_SSL_CA names a readable PEM", () => {
    const ssl = resolveSsl({
      connectionString: remote,
      caPath: "/certs/neon-ca.pem",
      readCa: (target) => {
        assert.equal(target, "/certs/neon-ca.pem");
        return PEMS.root;
      },
    });

    assert.deepEqual(ssl, { ca: PEMS.root, rejectUnauthorized: true });
  });

  it("fails with a message naming the variable when the CA cannot be read", () => {
    assert.throws(
      () =>
        resolveSsl({
          connectionString: remote,
          caPath: "/certs/missing.pem",
          readCa: () => {
            throw new Error("ENOENT: no such file or directory");
          },
        }),
      /DATABASE_SSL_CA could not be read from \/certs\/missing\.pem: ENOENT/
    );
  });

  it("keeps DATABASE_SSL=false authoritative over a configured CA", () => {
    assert.equal(
      resolveSsl({
        connectionString: remote,
        ssl: "false",
        caPath: "/certs/neon-ca.pem",
        readCa: () => PEMS.root,
      }),
      undefined
    );
  });

  it("honours sslmode: disable, and treats any other sslmode as TLS", () => {
    assert.equal(
      resolveSsl({ connectionString: `${remote}?sslmode=disable` }),
      undefined
    );
    assert.deepEqual(resolveSsl({ connectionString: `${remote}?sslmode=require` }), {
      rejectUnauthorized: false,
    });
  });

  it("lets DATABASE_SSL=true force TLS even for a loopback host", () => {
    assert.deepEqual(
      resolveSsl({ connectionString: loopback, ssl: "1" }),
      { rejectUnauthorized: false }
    );
  });

  it("uses no TLS when there is no connection string and no override", () => {
    assert.equal(resolveSsl({ connectionString: undefined }), undefined);
    assert.equal(
      resolveSsl({ connectionString: "not a url" }),
      undefined
    );
  });
});
