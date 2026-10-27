import { contractsVersion, type HealthResponse } from "@chat/contracts";
import express, { type Express } from "express";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");

  app.get("/health", (_request, response) => {
    const body: HealthResponse = {
      status: "ok",
      service: "api",
      contractsVersion,
    };

    response.status(200).json(body);
  });

  return app;
}
