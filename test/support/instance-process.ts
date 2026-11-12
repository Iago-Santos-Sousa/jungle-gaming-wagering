// Processo independente da aplicação usado nos testes multi-instância.
// Sobe uma instância completa (pool próprio de conexões), sinaliza READY, espera "go" e dispara as apostas em paralelo.
import "reflect-metadata";
import { createApp } from "../../src/bootstrap";
import { apiClient, submitWager, wagerBody } from "./api-client";
import { testConfig } from "./test-app";

const walletId = process.env.WALLET_ID ?? "";
const playerId = process.env.PLAYER_ID ?? "";
const uniqueCount = Number(process.env.UNIQUE_COUNT ?? "0");
const sharedIds = (process.env.SHARED_IDS ?? "").split(",").filter(Boolean);
const instance = process.env.INSTANCE ?? "0";

const app = await createApp(testConfig());
await app.listen(0, "127.0.0.1");
const { port } = app.getHttpServer().address() as { port: number };
const api = apiClient(`http://127.0.0.1:${port}`);

console.log("READY");
for await (const line of console) {
  if (line.trim() === "go") break;
}

const unique = Array.from({ length: uniqueCount }, (_, i) =>
  wagerBody({
    walletId,
    playerId,
    amount: "1.00",
    externalTransactionId: `p${instance}-${i}-${walletId}`,
  }),
);
// IDs compartilhados entre processos: o mesmo payload chega em todas as instâncias ao mesmo tempo
const shared = sharedIds.map((id) =>
  wagerBody({ walletId, playerId, amount: "1.00", externalTransactionId: id }),
);
const responses = await Promise.all(
  [...unique, ...shared].map((body) => submitWager(api, body)),
);

const statuses: Record<string, number> = {};
for (const response of responses)
  statuses[response.status] = (statuses[response.status] ?? 0) + 1;
console.log(JSON.stringify({ instance, statuses }));

await app.close();
process.exit(0);
