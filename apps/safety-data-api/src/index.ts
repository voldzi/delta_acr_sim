import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = await loadConfig();
const { app } = await createApp(config);

app.listen(config.port, () => {
  console.log(`Safety Data API listening on ${config.port}`);
});
