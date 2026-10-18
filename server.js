import "dotenv/config";
import mongoose from "mongoose";
import app from "./src/app.js";
import { processPending } from "./src/fbr.js";
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
  throw Error("Set JWT_SECRET to at least 32 random characters");
await mongoose.connect(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/shop_os?replicaSet=rs0",
);
const server = app.listen(process.env.PORT || 4000, () =>
  console.log("Shop OS API ready on port " + (process.env.PORT || 4000)),
);
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await processPending();
  } catch (e) {
    console.error("FBR worker:", e.message);
  } finally {
    busy = false;
  }
}, 15000);
process.on("SIGTERM", () => {
  clearInterval(timer);
  server.close(async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
});
