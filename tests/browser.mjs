import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
process.env.JWT_SECRET = "browser-test-secret-at-least-32-characters";
process.env.NODE_ENV = "test";
process.env.FRONTEND_ORIGIN = "http://127.0.0.1:5173";
const { default: app } = await import("../src/app.js");
const { Tenant, User, Product, Party } = await import("../src/models.js");
const { postTrade } = await import("../src/accounting.js");
const { createServer } =
  await import("../../frontend/node_modules/vite/dist/node/index.js");
const { chromium } = await import("playwright");
const dbPath = await mkdtemp(path.join(process.cwd(), "qa-browser-"));
let db, server, vite, browser;
const results = [];
try {
  db = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [
      {
        dbPath,
        args: [
          "--nounixsocket",
          "--setParameter",
          "diagnosticDataCollectionEnabled=false",
        ],
      },
    ],
    binary: { version: "7.0.14" },
  });
  await mongoose.connect(db.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  const tenant = await Tenant.create({
    name: "City Mart · Demo Shop",
    expires: new Date(Date.now() + 86400000),
  });
  const user = await User.create({
    tenant: tenant._id,
    name: "Haseeb Ahmed",
    email: "owner@demo.local",
    password: await bcrypt.hash("ChangeOwner123!", 4),
    role: "owner",
  });
  await User.create({
    name: "Ahmed Solutions",
    email: "admin@ahmedsolutions.local",
    password: await bcrypt.hash("ChangeAdmin123!", 4),
    role: "superadmin",
  });
  const supplier = await Party.create({
    tenant: tenant._id,
    name: "Prime Wholesale",
    type: "supplier",
  });
  await Party.create({
    tenant: tenant._id,
    name: "Ali Khan",
    type: "customer",
    phone: "03001234567",
  });
  const products = await Product.insertMany(
    [
      ["Premium Basmati Rice", "Grocery", 18500, 24000],
      ["Fresh Milk 1L", "Dairy", 18000, 22000],
      ["Classic Cotton Tee", "Clothing", 65000, 120000],
      ["Wireless Earbuds", "Electronics", 180000, 250000],
      ["Daily Care Shampoo", "Personal care", 32000, 45000],
      ["A5 Notebook", "Stationery", 12000, 20000],
    ].map(([name, category, cost, price], i) => ({
      tenant: tenant._id,
      name,
      sku: "SKU-" + i,
      barcode: "89010000000" + i,
      category,
      cost,
      price,
      unit: "Pieces",
      reorder: 10,
    })),
  );
  await postTrade(
    {
      tenant,
      user,
      body: {
        key: "browser-purchase",
        party: supplier.id,
        items: products.map((p) => ({
          product: p.id,
          quantity: 30,
          rate: p.cost / 100,
        })),
        payments: [],
      },
    },
    "purchase",
  );
  for (let i = 6; i >= 0; i--) {
    const p = products[i % products.length];
    const d = await postTrade(
      {
        tenant,
        user,
        body: {
          key: "browser-seed-" + i,
          items: [{ product: p.id, quantity: i + 2 }],
          payments: [{ account: "cash", amount: (p.price * (i + 2)) / 100 }],
        },
      },
      "sale",
    );
    const { Document, Ledger } = await import("../src/models.js");
    const date = new Date(Date.now() - i * 86400000);
    await Document.updateOne({ _id: d._id }, { date });
    await Ledger.updateMany({ document: d._id }, { date });
  }
  server = app.listen(4000, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  vite = await createServer({
    root: path.resolve("../frontend"),
    server: { host: "127.0.0.1", port: 5173 },
  });
  await vite.listen();
  let browserOptions = { headless: true, args: ["--no-sandbox"] };
  if (process.env.CHROMIUM_PACKAGE) {
    const { default: binary } = await import(process.env.CHROMIUM_PACKAGE);
    browserOptions = {
      ...browserOptions,
      executablePath: await binary.executablePath(),
      args: binary.args,
    };
  }
  if (process.env.CHROMIUM_EXECUTABLE)
    browserOptions = {
      headless: true,
      executablePath: process.env.CHROMIUM_EXECUTABLE,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
      ],
    };
  browser = await chromium.launch(browserOptions);
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:5173");
  await page.getByLabel("Email", { exact: true }).fill("owner@demo.local");
  await page.getByLabel("Password", { exact: true }).fill("ChangeOwner123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page
    .getByRole("heading", { name: "Sales trend", exact: true })
    .waitFor();
  await page.locator(".recharts-area").first().waitFor({ state: "visible" });
  await page.screenshot({
    path: path.resolve("../../Universal_Shop_OS_Desktop.png"),
    fullPage: true,
    animations: "disabled",
    style: ".toast { display: none !important; }",
  });
  results.push("Desktop dashboard login and data loading passed");
  await page.getByRole("link", { name: "Point of sale" }).click();
  await page.getByRole("button", { name: /Premium Basmati Rice/ }).click();
  await page.getByRole("button", { name: "Mark fully paid by cash" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("heading", { name: "Invoice & receipt" }).waitFor();
  await page.emulateMedia({ media: "print" });
  await page.pdf({
    path: path.resolve("../../Universal_Shop_OS_Invoice_QA.pdf"),
    format: "A4",
    printBackground: true,
  });
  await page.emulateMedia({ media: "screen" });
  results.push("POS checkout, persistent invoice and A4 print passed");
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByRole("button", { name: "Add product", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Browser test product");
  await page.getByLabel("SKU", { exact: true }).fill("BROWSER-TEST");
  await page.getByLabel("Selling price", { exact: true }).fill("100");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Browser test product", { exact: true }).waitFor();
  results.push("Product creation from browser passed");
  await page.getByRole("link", { name: "Reports", exact: true }).click();
  await page
    .getByRole("heading", { name: "Profit & loss", exact: true })
    .waitFor();
  results.push("Separate profit report loaded");
  await page.getByLabel("Interface language").selectOption("ur");
  assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
  await page.getByRole("link", { name: "جائزہ", exact: true }).click();
  await page
    .getByRole("heading", { name: "فروخت کا رجحان", exact: true })
    .waitFor();
  results.push("Urdu navigation and RTL passed");
  await page.getByLabel("Interface language").selectOption("roman");
  await page.getByRole("link", { name: "Jaiza", exact: true }).waitFor();
  assert.equal(await page.locator("html").getAttribute("dir"), "ltr");
  results.push("Roman Urdu language switching passed");
  await page.getByLabel("Interface language").selectOption("en");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: path.resolve("../../Universal_Shop_OS_Mobile.png"),
    fullPage: false,
    animations: "disabled",
    style: ".toast { display: none !important; }",
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile page overflow",
  );
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Point of sale" }).click();
  await page.getByRole("button", { name: /Fresh Milk/ }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "Mobile POS overflow",
  );
  results.push("390px dashboard and POS fit without horizontal overflow");
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("link", { name: "Inventory", exact: true }).click();
  await page.getByText("Browser test product", { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    "360px inventory overflow",
  );
  results.push("360px inventory cards fit without overflow");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByLabel("Email", { exact: true })
    .fill("admin@ahmedsolutions.local");
  await page.getByLabel("Password", { exact: true }).fill("ChangeAdmin123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Your shop network" }).waitFor();
  results.push("Separate superadmin console login passed");
  assert.deepEqual(errors, []);
  results.push("No browser runtime errors");
  console.log(results.join("\n"));
  await writeFile(
    path.resolve("../../browser-validation.txt"),
    results.join("\n"),
  );
} finally {
  await browser?.close();
  await vite?.close();
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  await db?.stop();
  await rm(dbPath, { recursive: true, force: true });
}
