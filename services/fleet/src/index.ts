import { loadFleetConfig } from "./config.ts";
import { Fleet } from "./fleet.ts";

const fleet = new Fleet(loadFleetConfig());
fleet.start().catch((err) => {
  console.error(err);
  process.exit(1);
});
