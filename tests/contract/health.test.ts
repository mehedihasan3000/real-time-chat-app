import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractsVersion, type HealthResponse } from "@chat/contracts";
import { createApp } from "../../apps/api/src/app.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test server to bind to an ephemeral TCP port.");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("GET /health", () => {
  it("returns the versioned health contract", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as HealthResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("x-powered-by")).toBeNull();
    expect(body).toEqual({
      status: "ok",
      service: "api",
      contractsVersion,
    });
  });

  it("returns 404 for an unknown route", async () => {
    const response = await fetch(`${baseUrl}/unknown`);

    expect(response.status).toBe(404);
  });
});

describe("shared contracts", () => {
  it("exports the expected version", () => {
    expect(contractsVersion).toBe("0.1.0");
  });
});
