import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Tenant, User, Product, Party } from "./models.js";
import { postTrade } from "./accounting.js";
await mongoose.connect(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/shop_os?replicaSet=rs0",
);
const adminEmail = process.env.SEED_ADMIN_EMAIL || "admin@ahmedsolutions.local";
if (!(await User.exists({ email: adminEmail })))
  await User.create({
    name: "Ahmed Solutions",
    email: adminEmail,
    password: await bcrypt.hash(
      process.env.SEED_ADMIN_PASSWORD || "ChangeAdmin123!",
      12,
    ),
    role: "superadmin",
  });
if (
  !(await User.exists({
    email: process.env.SEED_OWNER_EMAIL || "owner@demo.local",
  }))
) {
  const tenant = await Tenant.create({
    name: "City Mart · Demo Shop",
    expires: new Date(Date.now() + 365 * 86400000),
  });
  const user = await User.create({
    tenant: tenant._id,
    name: "Shop Owner",
    email: process.env.SEED_OWNER_EMAIL || "owner@demo.local",
    password: await bcrypt.hash(
      process.env.SEED_OWNER_PASSWORD || "ChangeOwner123!",
      12,
    ),
    role: "owner",
  });
  const supplier = await Party.create({
    tenant: tenant._id,
    type: "supplier",
    name: "Prime Wholesale",
    phone: "03001234567",
  });
  await Party.create({
    tenant: tenant._id,
    type: "customer",
    name: "Ali Khan",
    phone: "03121234567",
    address: "Peshawar",
    province: "Khyber Pakhtunkhwa",
  });
  const products = await Product.insertMany(
    [
      ["Premium Basmati Rice", "GRO-001", "Grocery", 18500, 24000, 60],
      ["Fresh Milk 1L", "GRO-002", "Dairy", 18000, 22000, 80],
      ["Classic Cotton Tee", "CLO-001", "Clothing", 65000, 120000, 24],
      ["Wireless Earbuds", "ELE-001", "Electronics", 180000, 250000, 18],
      ["Daily Care Shampoo", "COS-001", "Personal care", 32000, 45000, 40],
      ["A5 Notebook", "STA-001", "Stationery", 12000, 20000, 35],
    ].map(([name, sku, category, cost, price, qty], i) => ({
      tenant: tenant._id,
      name,
      sku,
      barcode: "89010000000" + i,
      category,
      cost,
      price,
      stock: 0,
      reorder: 10,
    })),
  );
  await postTrade(
    {
      tenant,
      user,
      body: {
        key: "seed-purchase-001",
        party: supplier.id,
        items: products.map((p, i) => ({
          product: p.id,
          quantity: [60, 80, 24, 18, 40, 35][i],
          rate: p.cost / 100,
        })),
        payments: [],
      },
    },
    "purchase",
  );
  for (let i = 6; i >= 0; i--) {
    const p = products[i % products.length];
    const doc = await postTrade(
      {
        tenant,
        user,
        body: {
          key: "seed-sale-" + i,
          items: [{ product: p.id, quantity: i + 1 }],
          payments: [{ account: "cash", amount: (p.price * (i + 1)) / 100 }],
        },
      },
      "sale",
    );
    const { Document, Ledger } = await import("./models.js");
    const date = new Date(Date.now() - i * 86400000);
    await Document.updateOne({ _id: doc._id }, { date });
    await Ledger.updateMany({ document: doc._id }, { date });
  }
  console.log(
    "Created isolated demo shop. Demo credentials are in .env.example.",
  );
} else console.log("Seed accounts already exist; no data changed.");
await mongoose.disconnect();
