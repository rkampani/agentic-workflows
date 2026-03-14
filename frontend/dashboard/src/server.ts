import express from "express";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PORT } from "./config.js";
import servicesRoute from "./routes/services.js";
import resultsRoute from "./routes/results.js";
import runRoute from "./routes/run.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// API routes
app.use("/api/services", servicesRoute);
app.use("/api/results", resultsRoute);
app.use("/api/run", runRoute);

// Serve dashboard UI
app.use(express.static(resolve(__dirname, "../public")));
app.get("*", (_req, res) => {
  res.sendFile(resolve(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
