import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import request from "supertest";
import bcrypt from "bcryptjs";
process.env.JWT_SECRET = "test-secret-at-least-32-characters-long";
process.env.NODE_ENV = "test";
process.env.FBR_ENCRYPTION_KEY = "test-encryption-key";
const { default: app } = await import("../src/app.js");
const { Tenant, User, Product, Party, Document, Ledger } =
  await import("../src/models.js");
const { cents, line } = await import("../src/money.js");
let mongo, owner, cashier, other, admin, tenant, dbPath;
before(async () => {
  dbPath = await mkdtemp(path.join(process.cwd(), "qa-db-"));
  mongo = await MongoMemoryReplSet.create({
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
  await mongoose.connect(mongo.getUri());
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  tenant = await Tenant.create({
    name: "Test shop",
    expires: new Date(Date.now() + 86400000),
  });
  const second = await Tenant.create({ name: "Other shop" });
  for (const [email, role, t] of [
    ["owner@test.com", "owner", tenant],
    ["cashier@test.com", "cashier", tenant],
    ["other@test.com", "owner", second],
    ["admin@test.com", "superadmin", null],
  ])
    await User.create({
      email,
      name: role,
      role,
      tenant: t?._id,
      password: await bcrypt.hash("TestPassword123!", 4),
    });
  owner = request.agent(app);
  cashier = request.agent(app);
  other = request.agent(app);
  admin = request.agent(app);
  for (const [agent, email] of [
    [owner, "owner@test.com"],
    [cashier, "cashier@test.com"],
    [other, "other@test.com"],
    [admin, "admin@test.com"],
  ])
    await agent
      .post("/api/auth/login")
      .send({ email, password: "TestPassword123!" })
      .expect(200);
});
after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  if (dbPath) await rm(dbPath, { recursive: true, force: true });
});
const uid = () => crypto.randomUUID();
const post = async (path, body) => {
  const r = await owner
    .post("/api/" + path)
    .send({ ...body, key: body.key || uid() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
test("rounding and tax use cents", () => {
  assert.equal(cents("1.005"), 101);
  assert.deepEqual(line(1, 11800, 0, 18, true), {
    net: 10000,
    tax: 1800,
    total: 11800,
  });
});
test("full stock, credit, payment, return and journal workflow", async () => {
  const p = await post("products", {
    name: "Rice",
    sku: "RICE",
    price: 150,
    cost: 100,
    openingStock: 10,
  });
  const customer = await post("parties", {
    name: "Ali",
    type: "customer",
    openingBalance: 50,
  });
  const supplier = await post("parties", {
    name: "Wholesale",
    type: "supplier",
  });
  const purchase = await post("purchases", {
    party: supplier._id,
    items: [{ product: p._id, quantity: 10, rate: 120 }],
    payments: [{ account: "bank", amount: 200 }],
  });
  let product = await Product.findById(p._id);
  assert.equal(product.stock, 20);
  assert.equal(product.cost, 11000);
  assert.equal(product.inventoryValue, 220000);
  assert.equal((await Party.findById(supplier._id)).balance, 100000);
  const saleKey = uid();
  const sale = await post("sales", {
    key: saleKey,
    party: customer._id,
    items: [{ product: p._id, quantity: 4 }],
    payments: [{ account: "cash", amount: 100 }],
  });
  assert.equal(sale.total, 60000);
  assert.equal(sale.cost, 44000);
  assert.equal((await Product.findById(p._id)).stock, 16);
  assert.equal((await Party.findById(customer._id)).balance, 55000);
  const repeated = await post("sales", {
    key: saleKey,
    party: customer._id,
    items: [{ product: p._id, quantity: 4 }],
    payments: [{ account: "cash", amount: 100 }],
  });
  assert.equal(repeated._id, sale._id);
  assert.equal((await Product.findById(p._id)).stock, 16);
  await post("payments", { party: customer._id, amount: 50, account: "cash" });
  assert.equal((await Party.findById(customer._id)).balance, 50000);
  await post("payments", { party: supplier._id, amount: 100, account: "bank" });
  assert.equal((await Party.findById(supplier._id)).balance, 90000);
  const back = await post("returns", {
    original: sale._id,
    items: [{ product: p._id, quantity: 1, restock: true }],
    account: "cash",
  });
  assert.equal(back.total, 15000);
  assert.equal((await Product.findById(p._id)).stock, 17);
  assert.equal((await Party.findById(customer._id)).balance, 35000);
  await owner
    .post("/api/returns")
    .send({
      original: sale._id,
      key: uid(),
      items: [{ product: p._id, quantity: 4 }],
    })
    .expect(422);
  await post("returns", {
    original: purchase._id,
    items: [{ product: p._id, quantity: 2 }],
    account: "bank",
  });
  assert.equal((await Product.findById(p._id)).stock, 15);
  assert.equal((await Party.findById(supplier._id)).balance, 66000);
  const expense = await post("expenses", {
    amount: 40,
    category: "Rent",
    account: "cash",
  });
  let report = await owner.get("/api/reports/profit-loss").expect(200);
  assert.equal(
    report.body.rows.find((x) => x.name === "Net profit").amount,
    8000,
  );
  await post("expenses/reverse", {
    original: expense._id,
    reason: "Wrong expense",
  });
  report = await owner.get("/api/reports/profit-loss").expect(200);
  assert.equal(
    report.body.rows.find((x) => x.name === "Net profit").amount,
    12000,
  );
  const journal = await Ledger.find({ tenant: tenant._id });
  assert.equal(
    journal.reduce((s, x) => s + x.debit - x.credit, 0),
    0,
  );
  const inventory = journal
    .filter((x) => x.account === "inventory")
    .reduce((s, x) => s + x.debit - x.credit, 0);
  assert.equal(inventory, (await Product.findById(p._id)).inventoryValue);
  const cash = await owner.get("/api/reports/cash-ledger").expect(200);
  assert.equal(cash.body.closing, 15000);
});
test("permissions, tenant isolation and subscription checks", async () => {
  const p = await post("products", {
    name: "Private",
    sku: "PRIVATE",
    price: 10,
  });
  await other
    .get("/api/products?q=PRIVATE")
    .expect(200)
    .then((r) => assert.equal(r.body.rows.length, 0));
  await other
    .patch("/api/products/" + p._id)
    .send({ name: "Stolen", sku: "PRIVATE", price: 1 })
    .expect(404);
  await cashier
    .post("/api/products")
    .send({ name: "No", sku: "NO", price: 1 })
    .expect(403);
  await cashier.get("/api/reports/profit-loss").expect(403);
  await owner.get("/api/admin/shops").expect(403);
  await admin.get("/api/products").expect(403);
  await Tenant.updateOne({ _id: tenant._id }, { status: "suspended" });
  await owner.get("/api/products").expect(403);
  await Tenant.updateOne({ _id: tenant._id }, { status: "active" });
});
test("concurrent checkout never oversells", async () => {
  const p = await post("products", {
    name: "Last item",
    sku: "LAST",
    price: 20,
    cost: 10,
    openingStock: 1,
  });
  const body = () => ({
    key: uid(),
    items: [{ product: p._id, quantity: 1 }],
    payments: [{ account: "cash", amount: 20 }],
  });
  const results = await Promise.all([
    owner.post("/api/sales").send(body()),
    owner.post("/api/sales").send(body()),
  ]);
  assert.deepEqual(results.map((x) => x.status).sort(), [201, 422]);
  assert.equal((await Product.findById(p._id)).stock, 0);
});
test("stock adjustments, CSV import and duplicates are auditable", async () => {
  const p = await post("products", {
    name: "Adjust",
    sku: "ADJ",
    price: 30,
    cost: 10,
    openingStock: 5,
    barcode: "123456789",
  });
  await post("adjustments", {
    product: p._id,
    quantity: -2,
    reason: "Damaged stock",
  });
  assert.equal((await Product.findById(p._id)).stock, 3);
  const found = await owner.get("/api/products?q=123456789").expect(200);
  assert.equal(found.body.rows[0]._id, p._id);
  const preview = await owner
    .post("/api/import/preview")
    .attach(
      "file",
      Buffer.from("name,sku,price,cost,openingStock\nSoap,SOAP,60,40,10\n"),
      "products.csv",
    )
    .expect(200);
  assert.equal(preview.body.rows[0].sku, "SOAP");
  const imported = await owner
    .post("/api/import")
    .send({ rows: preview.body.rows })
    .expect(200);
  assert.equal(imported.body.added, 1);
  const duplicate = await owner
    .post("/api/import")
    .send({ rows: preview.body.rows })
    .expect(200);
  assert.equal(duplicate.body.errors.length, 1);
  const updated = await owner
    .post("/api/import")
    .send({
      rows: [{ name: "Soap new", sku: "SOAP", price: 70 }],
      updateExisting: true,
    })
    .expect(200);
  assert.equal(updated.body.updated, 1);
  assert.equal((await Product.findOne({ sku: "SOAP" })).stock, 10);
});
test("tax, invoice snapshot, negative stock and FBR activation", async () => {
  const p = await post("products", {
    name: "Tax item",
    sku: "TAX",
    price: 118,
    cost: 70,
    openingStock: 3,
    taxRate: 18,
    taxInclusive: true,
  });
  const s = await post("sales", {
    items: [{ product: p._id, quantity: 1 }],
    payments: [{ account: "cash", amount: 118 }],
  });
  assert.equal(s.net, 10000);
  assert.equal(s.tax, 1800);
  assert.equal(s.items[0].taxRate, 18);
  await owner.get("/api/documents/" + s._id).expect(200);
  await other.get("/api/documents/" + s._id).expect(404);
  await owner
    .post("/api/sales")
    .send({
      key: uid(),
      items: [{ product: p._id, quantity: 20 }],
      payments: [{ account: "cash", amount: 2360 }],
    })
    .expect(422);
  assert.equal((await Product.findById(p._id)).stock, 2);
  await owner.post("/api/fbr/" + s._id + "/submit").expect(422);
});
test("custom empty permissions deny all and cross-site mutation blocked", async () => {
  const u = await User.findOne({ role: "cashier" });
  u.permissions = [];
  await u.save();
  await cashier.post("/api/sales").send({}).expect(403);
  await owner
    .post("/api/expenses")
    .set("Origin", "https://evil.test")
    .send({ key: uid(), amount: 1, account: "cash" })
    .expect(403);
});

test("ledger empty date ranges use the correct opening balance", async () => {
  const before = await owner
    .get("/api/reports/cash-ledger?from=2000-01-01&to=2000-01-02")
    .expect(200);
  assert.equal(before.body.rows.length, 0);
  assert.equal(before.body.opening, 0);
  const all = await owner.get("/api/reports/cash-ledger").expect(200);
  const future = await owner
    .get("/api/reports/cash-ledger?from=2099-01-01&to=2099-01-02")
    .expect(200);
  assert.equal(future.body.opening, all.body.closing);
});

test("weighted average liquidation retains every paisa", async () => {
  const p = await post("products", {
    name: "Rounding",
    sku: "ROUND",
    price: 2,
    cost: 1,
    openingStock: 1,
  });
  const supplier = await post("parties", {
    name: "Rounding supplier",
    type: "supplier",
  });
  await post("purchases", {
    party: supplier._id,
    items: [{ product: p._id, quantity: 2, rate: 1.01 }],
    payments: [],
  });
  assert.equal((await Product.findById(p._id)).inventoryValue, 302);
  let totalCost = 0;
  for (let i = 0; i < 3; i++) {
    const s = await post("sales", {
      items: [{ product: p._id, quantity: 1 }],
      payments: [{ account: "cash", amount: 2 }],
    });
    totalCost += s.cost;
  }
  assert.equal(totalCost, 302);
  assert.equal((await Product.findById(p._id)).stock, 0);
  assert.equal((await Product.findById(p._id)).inventoryValue, 0);
});

test("FBR statuses require item acceptance and uncertain invoices cannot be retried or returned", async () => {
  const { FbrConfig, FbrSubmission } = await import("../src/models.js");
  const { encrypt, submit } = await import("../src/fbr.js");
  const p = await post("products", {
    name: "FBR mapped",
    sku: "FBR",
    price: 118,
    cost: 50,
    openingStock: 3,
    taxRate: 18,
    taxInclusive: true,
    hsCode: "0101.2100",
    saleType: "Goods at standard rate (default)",
    unit: "Numbers, pieces, units",
  });
  const buyer = await post("parties", {
    name: "Buyer",
    type: "customer",
    province: "Khyber Pakhtunkhwa",
    address: "Peshawar",
  });
  await FbrConfig.create({
    tenant: tenant._id,
    enabled: true,
    environment: "sandbox",
    token: encrypt("simulated-token-no-external-request"),
    ntn: "1234567",
    businessName: "Test",
    province: "Khyber Pakhtunkhwa",
    address: "Peshawar",
    scenarioId: "SN001",
  });
  const s = await post("sales", {
    party: buyer._id,
    items: [{ product: p._id, quantity: 1 }],
    payments: [{ account: "cash", amount: 118 }],
  });
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      assert.equal(body.items[0].rate, "18%");
      return new Response(
        JSON.stringify({
          invoiceNumber: "SIMULATED",
          validationResponse: {
            statusCode: "00",
            invoiceStatuses: [{ statusCode: "01" }],
          },
        }),
        { status: 200 },
      );
    };
    let result = await submit(tenant._id, s._id, null);
    assert.equal(result.status, "Rejected");
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          invoiceNumber: "SIMULATED",
          validationResponse: {
            statusCode: "00",
            invoiceStatuses: [{ statusCode: "00" }],
          },
        }),
        { status: 200 },
      );
    result = await submit(tenant._id, s._id, null);
    assert.equal(result.status, "Accepted");
    await assert.rejects(() => submit(tenant._id, s._id, null), /Reconcile/);
    const uncertain = await post("sales", {
      party: buyer._id,
      items: [{ product: p._id, quantity: 1 }],
      payments: [{ account: "cash", amount: 118 }],
    });
    globalThis.fetch = async () => {
      throw Error("Simulated timeout");
    };
    await assert.rejects(
      () => submit(tenant._id, uncertain._id, null),
      /timeout/,
    );
    assert.equal(
      (await FbrSubmission.findOne({ document: uncertain._id })).status,
      "Retry Required",
    );
    await assert.rejects(
      () => submit(tenant._id, uncertain._id, null),
      /Reconcile/,
    );
    await owner
      .post("/api/returns")
      .send({
        key: uid(),
        original: uncertain._id,
        items: [{ product: p._id, quantity: 1 }],
      })
      .expect(422);
  } finally {
    globalThis.fetch = realFetch;
  }
});
