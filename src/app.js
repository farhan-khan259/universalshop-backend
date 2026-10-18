import express from "express";
import mongoose from "mongoose";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import multer from "multer";
import ExcelJS from "exceljs";
import { parse as parseCsv } from "csv-parse/sync";
import { z } from "zod";
import pino from "pino";
import {
  Tenant,
  User,
  Product,
  Party,
  Document,
  Ledger,
  Movement,
  Audit,
  Refresh,
  FbrConfig,
  FbrSubmission,
  ImportJob,
} from "./models.js";
import { auth, permit, permitted, issue, hash, publicUser } from "./auth.js";
import {
  postTrade,
  postPayment,
  postExpense,
  adjustment,
  returns,
  reverseExpense,
  createDoc,
} from "./accounting.js";
import { cents } from "./money.js";
import { summary, report } from "./reports.js";
import { encrypt, submit } from "./fbr.js";
const log = pino({
  level: process.env.NODE_ENV === "test" ? "silent" : "info",
});
const app = express();
app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
    credentials: true,
  }),
);
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
app.use("/api", rateLimit({ windowMs: 60000, limit: 300 }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (
    req.headers["sec-fetch-site"] === "cross-site" &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method)
  )
    return res.status(403).json({ error: "Cross-site request blocked" });
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    origin &&
    origin !== (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  )
    return res.status(403).json({ error: "Untrusted origin" });
  next();
});
const loginLimit = rateLimit({ windowMs: 15 * 60000, limit: 30 });
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
const asyncRoute = (f) => (req, res, next) =>
  Promise.resolve(f(req, res, next)).catch(next);
function safeDocument(user, record) {
  const d = record.toObject ? record.toObject() : record;
  if (["owner", "manager", "accountant", "inventory"].includes(user.role))
    return d;
  delete d.cost;
  d.items = d.items?.map(({ cost, extendedCost, ...item }) => item);
  return d;
}
const scoped = (req) => ({ tenant: req.tenant._id });
const productSchema = z.object({
  name: z.string().trim().min(1).max(160),
  sku: z.string().trim().min(1).max(80),
  barcode: z.string().trim().max(100).optional(),
  category: z.string().max(80).optional(),
  brand: z.string().max(80).optional(),
  unit: z.string().max(80).optional(),
  description: z.string().max(1000).optional(),
  image: z.string().max(1500000).optional(),
  price: z.coerce.number().min(0).max(1e10),
  cost: z.coerce.number().min(0).max(1e10).default(0),
  wholesale: z.coerce.number().min(0).default(0),
  openingStock: z.coerce.number().min(0).max(1e8).default(0),
  reorder: z.coerce.number().min(0).default(5),
  taxRate: z.coerce.number().min(0).max(100).default(0),
  taxInclusive: z.boolean().default(false),
  hsCode: z.string().optional(),
  saleType: z.string().optional(),
  sroSchedule: z.string().optional(),
  sroItem: z.string().optional(),
});
app.get("/api/health", (_req, res) =>
  res.json({ ok: true, database: mongoose.connection.readyState === 1 }),
);
app.post(
  "/api/auth/login",
  loginLimit,
  asyncRoute(async (req, res) => {
    const b = z
      .object({ email: z.email(), password: z.string() })
      .parse(req.body);
    const u = await User.findOne({
      email: b.email.toLowerCase(),
      active: true,
    }).select("+password");
    if (!u || !(await bcrypt.compare(b.password, u.password)))
      return res.status(401).json({ error: "Incorrect email or password" });
    u.lastLogin = new Date();
    await u.save();
    await issue(res, u);
    res.json(publicUser(u));
  }),
);
app.post(
  "/api/auth/refresh",
  asyncRoute(async (req, res) => {
    const record = await Refresh.findOneAndDelete({
      hash: hash(req.cookies.refresh || ""),
      expires: { $gt: new Date() },
    });
    if (!record) return res.status(401).json({ error: "Session expired" });
    const u = await User.findById(record.user);
    if (!u?.active) return res.status(401).json({ error: "Account inactive" });
    await issue(res, u);
    res.json(publicUser(u));
  }),
);
app.post(
  "/api/auth/logout",
  asyncRoute(async (req, res) => {
    await Refresh.deleteOne({ hash: hash(req.cookies.refresh || "") });
    res.clearCookie("access", { path: "/api" });
    res.clearCookie("refresh", { path: "/api" });
    res.json({ ok: true });
  }),
);
app.use("/api", auth);
app.get("/api/me", (req, res) =>
  res.json({ user: publicUser(req.user), tenant: req.tenant }),
);
app.post(
  "/api/auth/password",
  asyncRoute(async (req, res) => {
    const b = z
      .object({ current: z.string(), password: z.string().min(12) })
      .parse(req.body);
    const u = await User.findById(req.user._id).select("+password");
    if (!(await bcrypt.compare(b.current, u.password)))
      throw Object.assign(Error("Current password incorrect"), { status: 422 });
    u.password = await bcrypt.hash(b.password, 12);
    u.tokenVersion++;
    await u.save();
    await Refresh.deleteMany({ user: u._id });
    await issue(res, u);
    res.json({ ok: true });
  }),
);
app.use("/api/admin", (req, res, next) =>
  req.user.role === "superadmin"
    ? next()
    : res.status(403).json({ error: "Super admin only" }),
);
app.get(
  "/api/admin/shops",
  asyncRoute(async (_req, res) => {
    const shops = await Tenant.find().lean();
    res.json(
      await Promise.all(
        shops.map(async (t) => ({
          ...t,
          users: await User.countDocuments({ tenant: t._id }),
          products: await Product.countDocuments({ tenant: t._id }),
          owner: await User.findOne({ tenant: t._id, role: "owner" }).select(
            "email name lastLogin",
          ),
        })),
      ),
    );
  }),
);
app.post(
  "/api/admin/shops",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1),
        email: z.email(),
        owner: z.string().min(1),
        password: z.string().min(12),
        expires: z.string(),
        plan: z.string().default("Standard"),
        userLimit: z.coerce.number().int().min(1).max(100),
      })
      .parse(req.body);
    let t;
    await mongoose.connection.transaction(async (session) => {
      [t] = await Tenant.create(
        [
          {
            name: b.name,
            expires: new Date(b.expires),
            plan: b.plan,
            userLimit: b.userLimit,
            subscriptionHistory: [
              { action: "created", date: new Date(), plan: b.plan },
            ],
          },
        ],
        { session },
      );
      await User.create(
        [
          {
            tenant: t._id,
            name: b.owner,
            email: b.email,
            password: await bcrypt.hash(b.password, 12),
            role: "owner",
          },
        ],
        { session },
      );
      await Audit.create(
        [{ user: req.user._id, tenant: t._id, action: "create shop" }],
        { session },
      );
    });
    res.status(201).json(t);
  }),
);
app.patch(
  "/api/admin/shops/:id",
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        status: z.enum(["active", "suspended"]).optional(),
        expires: z.string().optional(),
        plan: z.string().optional(),
        userLimit: z.coerce.number().int().min(1).optional(),
      })
      .parse(req.body);
    const t = await Tenant.findByIdAndUpdate(
      req.params.id,
      { $set: b, $push: { subscriptionHistory: { ...b, date: new Date() } } },
      { new: true },
    );
    await Audit.create({
      user: req.user._id,
      tenant: t._id,
      action: "update subscription",
      details: b,
    });
    res.json(t);
  }),
);
app.post(
  "/api/admin/shops/:id/reset",
  asyncRoute(async (req, res) => {
    const b = z.object({ password: z.string().min(12) }).parse(req.body);
    const u = await User.findOne({ tenant: req.params.id, role: "owner" });
    if (!u) throw Error("Owner not found");
    u.password = await bcrypt.hash(b.password, 12);
    u.tokenVersion++;
    await u.save();
    await Refresh.deleteMany({ user: u._id });
    await Audit.create({
      user: req.user._id,
      tenant: u.tenant,
      action: "owner password reset",
    });
    res.json({ ok: true });
  }),
);
app.use("/api", (req, res, next) =>
  req.tenant
    ? next()
    : res.status(403).json({
        error: "Use the separate shop owner account to access shop data",
      }),
);
app.get(
  "/api/products",
  asyncRoute(async (req, res) => {
    const f = {
      ...scoped(req),
      active: req.query.archived === "true" ? false : true,
    };
    if (req.query.q) {
      const q = String(req.query.q)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .slice(0, 100);
      f.$or = ["name", "sku", "barcode", "category"].map((k) => ({
        [k]: { $regex: q, $options: "i" },
      }));
    }
    if (req.query.category) f.category = String(req.query.category);
    const page = Math.max(1, Number(req.query.page) || 1),
      limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    let rows = await Product.find(f)
      .sort({ name: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();
    if (
      !["owner", "manager", "accountant", "inventory"].includes(req.user.role)
    )
      rows = rows.map(({ cost, priceHistory, ...p }) => p);
    res.json({ rows, total: await Product.countDocuments(f), page, limit });
  }),
);
async function addProduct(req, b, session) {
  const data = {
    ...b,
    tenant: req.tenant._id,
    cost: cents(b.cost),
    price: cents(b.price),
    wholesale: cents(b.wholesale),
    stock: b.openingStock,
    inventoryValue: Math.round(b.openingStock * cents(b.cost)),
  };
  if (!data.barcode)
    data.barcode = "20" + crypto.randomInt(1000000000, 9999999999).toString();
  const [p] = await Product.create([data], { session });
  if (p.stock) {
    const r = { ...req, body: { key: "opening:" + p.id } };
    const value = p.inventoryValue;
    const d = await createDoc(
      r,
      session,
      { kind: "adjustment", notes: "Opening stock", total: value },
      [
        { account: "inventory", debit: value },
        { account: "opening-equity", credit: value },
      ],
    );
    await Movement.create(
      [
        {
          tenant: p.tenant,
          product: p._id,
          document: d._id,
          quantity: p.stock,
          before: 0,
          after: p.stock,
          cost: p.cost,
          reason: "Opening stock",
          user: req.user._id,
        },
      ],
      { session },
    );
  }
  return p;
}
app.post(
  "/api/products",
  permit("products"),
  asyncRoute(async (req, res) => {
    const b = productSchema.parse(req.body);
    let p;
    await mongoose.connection.transaction(async (session) => {
      p = await addProduct(req, b, session);
      await Audit.create(
        [
          {
            ...scoped(req),
            user: req.user._id,
            action: "product created",
            entity: p.id,
          },
        ],
        { session },
      );
    });
    res.status(201).json(p);
  }),
);
app.patch(
  "/api/products/:id",
  permit("products"),
  asyncRoute(async (req, res) => {
    const b = productSchema
      .omit({ cost: true, openingStock: true })
      .parse(req.body);
    const p = await Product.findOne({ ...scoped(req), _id: req.params.id });
    if (!p) throw Object.assign(Error("Product not found"), { status: 404 });
    p.priceHistory.push({
      date: new Date(),
      price: p.price,
      user: req.user._id,
    });
    Object.assign(p, {
      ...b,
      price: cents(b.price),
      wholesale: cents(b.wholesale),
    });
    p.barcode = b.barcode || undefined;
    await p.save();
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "product edited",
      entity: p.id,
    });
    res.json(p);
  }),
);
app.delete(
  "/api/products/:id",
  permit("products"),
  asyncRoute(async (req, res) => {
    const p = await Product.findOneAndUpdate(
      { ...scoped(req), _id: req.params.id },
      { active: false },
      { new: true },
    );
    if (!p) throw Object.assign(Error("Product not found"), { status: 404 });
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "product archived",
      entity: p.id,
    });
    res.json({ ok: true });
  }),
);
app.get(
  "/api/products/:id/history",
  permit("stock"),
  asyncRoute(async (req, res) =>
    res.json(
      await Movement.find({ ...scoped(req), product: req.params.id })
        .sort({ createdAt: -1 })
        .limit(200),
    ),
  ),
);
app.post(
  "/api/import/preview",
  permit("products"),
  upload.single("file"),
  asyncRoute(async (req, res) => {
    if (!req.file) throw Error("Select CSV or XLSX file");
    let rows;
    if (req.file.originalname.toLowerCase().endsWith(".csv")) {
      rows = parseCsv(req.file.buffer.toString("utf8"), {
        columns: true,
        skip_empty_lines: true,
        bom: true,
        max_record_size: 100000,
      });
    } else if (req.file.originalname.toLowerCase().endsWith(".xlsx")) {
      const book = new ExcelJS.Workbook();
      await book.xlsx.load(req.file.buffer);
      const sheet = book.worksheets[0];
      if (!sheet) throw Error("Workbook is empty");
      if (sheet.rowCount > 5001) throw Error("Maximum 5,000 rows");
      const headers = sheet
        .getRow(1)
        .values.slice(1)
        .map((v) => String(v ?? ""));
      rows = [];
      sheet.eachRow((row, i) => {
        if (i === 1) return;
        rows.push(
          Object.fromEntries(
            headers.map((h, j) => [
              h,
              typeof row.getCell(j + 1).value === "object"
                ? String(row.getCell(j + 1).text)
                : (row.getCell(j + 1).value ?? ""),
            ]),
          ),
        );
      });
    } else throw Error("Use CSV or XLSX format");
    if (rows.length > 5000) throw Error("Maximum 5,000 rows per import");
    res.json({ columns: Object.keys(rows[0] || {}), rows });
  }),
);
app.post(
  "/api/import",
  permit("products"),
  asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body.rows) || req.body.rows.length > 5000)
      throw Error("Import at most 5,000 rows");
    let added = 0,
      updated = 0;
    const errors = [];
    for (const [i, row] of req.body.rows.entries()) {
      try {
        const b = productSchema.parse(row);
        const p = await Product.findOne({
          ...scoped(req),
          $or: [{ sku: b.sku }, ...(b.barcode ? [{ barcode: b.barcode }] : [])],
        });
        if (p) {
          if (!req.body.updateExisting) throw Error("Duplicate SKU/barcode");
          if (p.sku !== b.sku)
            throw Error("Barcode belongs to a different SKU");
          Object.assign(p, {
            name: b.name,
            category: b.category,
            brand: b.brand,
            price: cents(b.price),
            wholesale: cents(b.wholesale),
            reorder: b.reorder,
          });
          await p.save();
          updated++;
        } else {
          await mongoose.connection.transaction(async (session) =>
            addProduct(req, b, session),
          );
          added++;
        }
      } catch (e) {
        errors.push({
          row: i + 2,
          error:
            e.issues?.map((x) => x.path + ": " + x.message).join("; ") ||
            e.message,
        });
      }
    }
    const result = { added, updated, errors };
    await ImportJob.create({
      ...scoped(req),
      user: req.user._id,
      summary: result,
    });
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "product import",
      details: result,
    });
    res.json(result);
  }),
);
app.get(
  "/api/parties",
  asyncRoute(async (req, res) =>
    res.json(
      await Party.find({
        ...scoped(req),
        active: true,
        ...(req.query.type ? { type: String(req.query.type) } : {}),
      })
        .sort({ name: 1 })
        .limit(1000),
    ),
  ),
);
const partySchema = z.object({
  name: z.string().min(1).max(160),
  type: z.enum(["customer", "supplier"]),
  phone: z.string().optional(),
  address: z.string().optional(),
  email: z.string().optional(),
  ntn: z.string().optional(),
  province: z.string().optional(),
  registrationType: z
    .enum(["Registered", "Unregistered"])
    .default("Unregistered"),
  notes: z.string().optional(),
  openingBalance: z.coerce.number().min(0).default(0),
  creditLimit: z.coerce.number().min(0).default(0),
});
app.post(
  "/api/parties",
  permit("parties"),
  asyncRoute(async (req, res) => {
    const b = partySchema.parse(req.body);
    let p;
    await mongoose.connection.transaction(async (session) => {
      [p] = await Party.create(
        [
          {
            ...b,
            ...scoped(req),
            balance: cents(b.openingBalance),
            creditLimit: cents(b.creditLimit),
          },
        ],
        { session },
      );
      if (p.balance) {
        const r = { ...req, body: { key: "party-opening:" + p.id } };
        await createDoc(
          r,
          session,
          {
            kind: "adjustment",
            party: p._id,
            partyName: p.name,
            total: p.balance,
            notes: "Opening balance",
          },
          p.type === "customer"
            ? [
                { account: "receivable", party: p._id, debit: p.balance },
                { account: "opening-equity", credit: p.balance },
              ]
            : [
                { account: "opening-equity", debit: p.balance },
                { account: "payable", party: p._id, credit: p.balance },
              ],
        );
      }
    });
    res.status(201).json(p);
  }),
);
app.patch(
  "/api/parties/:id",
  permit("parties"),
  asyncRoute(async (req, res) => {
    const b = partySchema
      .omit({ openingBalance: true, type: true })
      .parse(req.body);
    const p = await Party.findOneAndUpdate(
      { ...scoped(req), _id: req.params.id },
      { ...b, creditLimit: cents(b.creditLimit) },
      { new: true },
    );
    if (!p) throw Object.assign(Error("Not found"), { status: 404 });
    res.json(p);
  }),
);
app.delete(
  "/api/parties/:id",
  permit("parties"),
  asyncRoute(async (req, res) => {
    const p = await Party.findOne({ ...scoped(req), _id: req.params.id });
    if (!p || p.balance !== 0)
      throw Error("Party missing or has outstanding balance");
    p.active = false;
    await p.save();
    res.json({ ok: true });
  }),
);
const keyed = (req, res, next) => {
  if (
    typeof req.body.key !== "string" ||
    req.body.key.length < 8 ||
    req.body.key.length > 100
  )
    return res
      .status(422)
      .json({ error: "A stable idempotency key is required" });
  next();
};
for (const [path, permission, handler] of [
  ["sales", "sales", (r) => postTrade(r, "sale")],
  ["purchases", "purchases", (r) => postTrade(r, "purchase")],
  ["payments", "payments", postPayment],
  ["expenses", "expenses", postExpense],
  ["adjustments", "stock", adjustment],
  ["returns", "returns", returns],
  ["expenses/reverse", "expenses", reverseExpense],
])
  app.post(
    "/api/" + path,
    permit(permission),
    keyed,
    asyncRoute(async (req, res) =>
      res.status(201).json(safeDocument(req.user, await handler(req))),
    ),
  );
app.get(
  "/api/documents",
  asyncRoute(async (req, res) => {
    const kind = req.query.kind;
    const docPermissions = {
      sale: "sales",
      purchase: "purchases",
      payment: "payments",
      expense: "expenses",
      "sale-return": "returns",
      "purchase-return": "returns",
      adjustment: "stock",
    };
    const allowed = Object.keys(docPermissions).filter(
      (k) =>
        permitted(req.user, docPermissions[k]) ||
        permitted(req.user, "reports"),
    );
    if (allowed && kind && !allowed.includes(kind))
      return res.status(403).json({ error: "Permission denied" });
    const f = {
      ...scoped(req),
      ...(kind ? { kind } : allowed ? { kind: { $in: allowed } } : {}),
    };
    const page = Math.max(1, Number(req.query.page) || 1);
    res.json({
      rows: await Document.find(f)
        .sort({ date: -1 })
        .skip((page - 1) * 50)
        .limit(50)
        .then((rows) => rows.map((d) => safeDocument(req.user, d))),
      total: await Document.countDocuments(f),
    });
  }),
);
app.get(
  "/api/documents/:id",
  asyncRoute(async (req, res) => {
    const doc = await Document.findOne({ ...scoped(req), _id: req.params.id });
    if (!doc) throw Object.assign(Error("Invoice not found"), { status: 404 });
    const permissions = {
      sale: "sales",
      purchase: "purchases",
      payment: "payments",
      expense: "expenses",
      "sale-return": "returns",
      "purchase-return": "returns",
      adjustment: "stock",
    };
    if (
      !permitted(req.user, permissions[doc.kind]) &&
      !permitted(req.user, "reports")
    )
      throw Object.assign(Error("Permission denied"), { status: 403 });
    res.json({
      document: safeDocument(req.user, doc),
      tenant: req.tenant,
      fbr: await FbrSubmission.findOne({
        ...scoped(req),
        document: doc._id,
      }).select("status environment invoiceNumber"),
    });
  }),
);
app.get(
  "/api/dashboard",
  permit("reports"),
  asyncRoute(async (req, res) =>
    res.json(await summary(req.tenant._id, req.query)),
  ),
);
app.get(
  "/api/reports/:type",
  permit("reports"),
  asyncRoute(async (req, res) =>
    res.json(await report(req.tenant._id, req.params.type, req.query)),
  ),
);
app.get("/api/settings", (req, res) =>
  res.json({ ...req.tenant.settings, name: req.tenant.name }),
);
app.patch(
  "/api/settings",
  permit("settings"),
  asyncRoute(async (req, res) => {
    const s = z
      .object({
        name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
        ntn: z.string().optional(),
        strn: z.string().optional(),
        logo: z.string().max(1500000).optional(),
        footer: z.string().max(400).optional(),
        invoicePrefix: z.string().regex(/^[A-Z0-9-]{1,12}$/),
        receiptSize: z.enum(["A4", "80mm", "58mm"]),
        negativeStock: z.boolean(),
        creditSales: z.boolean(),
        discounts: z.boolean(),
        cashOpening: z.coerce.number().optional(),
        bankOpening: z.coerce.number().optional(),
      })
      .parse(req.body);
    req.tenant.name = s.name;
    const { cashOpening, bankOpening, ...settings } = s;
    req.tenant.settings = { ...req.tenant.settings, ...settings };
    await req.tenant.save();
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "business settings changed",
    });
    res.json(req.tenant.settings);
  }),
);
app.post(
  "/api/accounts/opening",
  permit("settings"),
  keyed,
  asyncRoute(async (req, res) => {
    const { transact } = await import("./accounting.js");
    res.json(
      await transact(req, async (session) => {
        if (
          await Document.exists({
            ...scoped(req),
            notes: "Opening cash/bank",
          }).session(session)
        )
          throw Error("Opening accounts already recorded");
        const cash = cents(req.body.cash),
          bank = cents(req.body.bank);
        if (cash < 0 || bank < 0)
          throw Error("Opening balances cannot be negative");
        return createDoc(
          req,
          session,
          {
            kind: "adjustment",
            notes: "Opening cash/bank",
            total: cash + bank,
          },
          [
            { account: "cash", debit: cash },
            { account: "bank", debit: bank },
            { account: "opening-equity", credit: cash + bank },
          ],
        );
      }),
    );
  }),
);
app.get(
  "/api/users",
  permit("users"),
  asyncRoute(async (req, res) =>
    res.json((await User.find({ ...scoped(req) })).map(publicUser)),
  ),
);
app.post(
  "/api/users",
  permit("users"),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        name: z.string().min(1),
        email: z.email(),
        password: z.string().min(12),
        role: z.enum(["manager", "cashier", "inventory", "accountant"]),
        permissions: z
          .array(
            z.enum([
              "products",
              "parties",
              "sales",
              "purchases",
              "payments",
              "expenses",
              "reports",
              "returns",
              "stock",
              "fbr",
            ]),
          )
          .optional(),
      })
      .parse(req.body);
    let u;
    await mongoose.connection.transaction(async (session) => {
      await Tenant.updateOne(
        { _id: req.tenant._id },
        { $set: { updatedAt: new Date() } },
        { session },
      );
      if (
        (await User.countDocuments({ ...scoped(req), active: true }).session(
          session,
        )) >= req.tenant.userLimit
      )
        throw Error("Subscription user limit reached");
      [u] = await User.create(
        [{ ...b, ...scoped(req), password: await bcrypt.hash(b.password, 12) }],
        { session },
      );
    });
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "user created",
      entity: u.id,
    });
    res.status(201).json(publicUser(u));
  }),
);
app.patch(
  "/api/users/:id",
  permit("users"),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        active: z.boolean().optional(),
        permissions: z
          .array(
            z.enum([
              "products",
              "parties",
              "sales",
              "purchases",
              "payments",
              "expenses",
              "reports",
              "returns",
              "stock",
              "fbr",
            ]),
          )
          .optional(),
      })
      .parse(req.body);
    const u = await User.findOne({
      ...scoped(req),
      _id: req.params.id,
      role: { $ne: "owner" },
    });
    if (!u) throw Error("Staff user not found");
    Object.assign(u, b);
    u.tokenVersion++;
    await u.save();
    await Refresh.deleteMany({ user: u._id });
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "user permissions updated",
      entity: u.id,
    });
    res.json(publicUser(u));
  }),
);
app.get(
  "/api/audit",
  permit("settings"),
  asyncRoute(async (req, res) =>
    res.json(await Audit.find(scoped(req)).sort({ createdAt: -1 }).limit(200)),
  ),
);
app.get(
  "/api/fbr/config",
  permit("fbr"),
  asyncRoute(async (req, res) => {
    const c = await FbrConfig.findOne(scoped(req)).lean();
    if (c) {
      c.hasToken = !!c.token;
      delete c.token;
    }
    res.json(c || { environment: "sandbox", enabled: false });
  }),
);
app.patch(
  "/api/fbr/config",
  permit("settings"),
  asyncRoute(async (req, res) => {
    const b = z
      .object({
        environment: z.enum(["sandbox", "production"]),
        enabled: z.boolean(),
        token: z.string().optional(),
        ntn: z.string(),
        province: z.string(),
        address: z.string(),
        businessName: z.string(),
        scenarioId: z.string().optional(),
      })
      .parse(req.body);
    if (b.token) b.token = encrypt(b.token);
    else delete b.token;
    const c = await FbrConfig.findOneAndUpdate(
      scoped(req),
      { $set: b },
      { upsert: true, new: true },
    );
    req.tenant.settings = { ...req.tenant.settings, fbrEnabled: b.enabled };
    await req.tenant.save();
    res.json({
      enabled: c.enabled,
      environment: c.environment,
      hasToken: !!c.token,
    });
  }),
);
app.get(
  "/api/fbr/submissions",
  permit("fbr"),
  asyncRoute(async (req, res) =>
    res.json(
      await FbrSubmission.find(scoped(req))
        .sort({ createdAt: -1 })
        .limit(200)
        .populate("document", "number total"),
    ),
  ),
);
app.post(
  "/api/fbr/:id/validate",
  permit("fbr"),
  asyncRoute(async (req, res) =>
    res.json(await submit(req.tenant._id, req.params.id, req.user._id, true)),
  ),
);
app.post(
  "/api/fbr/:id/submit",
  permit("fbr"),
  asyncRoute(async (req, res) =>
    res.json(await submit(req.tenant._id, req.params.id, req.user._id)),
  ),
);
app.post(
  "/api/fbr/:id/reconcile",
  permit("settings"),
  asyncRoute(async (req, res) => {
    if (!req.body.confirmedNotReceived || !req.body.reason?.trim())
      throw Error("Integrator confirmation and reason required");
    const job = await FbrSubmission.findOneAndUpdate(
      { ...scoped(req), document: req.params.id, status: "Retry Required" },
      { $set: { status: "Pending", error: req.body.reason } },
      { new: true },
    );
    if (!job) throw Error("Uncertain submission not found");
    await Audit.create({
      ...scoped(req),
      user: req.user._id,
      action: "FBR retry authorized after reconciliation",
      details: { invoice: req.params.id, reason: req.body.reason },
    });
    res.json(job);
  }),
);
app.get(
  "/api/backup",
  permit("settings"),
  asyncRoute(async (req, res) => {
    const data = {
      format: "shop-os-tenant-export-v1",
      exportedAt: new Date(),
      settings: req.tenant.settings,
    };
    for (const m of [
      Product,
      Party,
      Document,
      Ledger,
      Movement,
      Audit,
      ImportJob,
    ])
      data[m.modelName] = await m.find(scoped(req)).lean();
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="shop-backup.json"',
    );
    res.json(data);
  }),
);
app.use((error, req, res, _next) => {
  log.error(
    { err: error, method: req.method, path: req.path },
    "Request failed",
  );
  res
    .status(
      error.status ||
        (error instanceof z.ZodError
          ? 422
          : error.code === 11000
            ? 409
            : mongoose.Error.CastError &&
                error instanceof mongoose.Error.CastError
              ? 422
              : 500),
    )
    .json({
      error:
        error instanceof z.ZodError
          ? error.issues
              .map((x) => x.path.join(".") + ": " + x.message)
              .join("; ")
          : error.code === 11000
            ? "Duplicate SKU, barcode, email, or transaction key."
            : error.status || process.env.NODE_ENV !== "production"
              ? error.message
              : "Request failed. Please contact support.",
    });
});
export default app;
