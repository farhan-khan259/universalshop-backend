import mongoose from "mongoose";
const { Schema, model } = mongoose;
const tenant = {
  tenant: {
    type: Schema.Types.ObjectId,
    ref: "Tenant",
    required: true,
    index: true,
  },
};
const opts = { timestamps: true };
export const Tenant = model(
  "Tenant",
  new Schema(
    {
      name: String,
      status: { type: String, default: "active" },
      expires: Date,
      userLimit: { type: Number, default: 5 },
      plan: { type: String, default: "Standard" },
      settings: {
        type: Schema.Types.Mixed,
        default: () => ({
          currency: "PKR",
          timezone: "Asia/Karachi",
          invoicePrefix: "INV",
          receiptSize: "A4",
          footer: "Thank you for shopping with us.",
          negativeStock: false,
          creditSales: true,
          discounts: true,
        }),
      },
      subscriptionHistory: [Schema.Types.Mixed],
    },
    opts,
  ),
);
export const User = model(
  "User",
  new Schema(
    {
      tenant: { type: Schema.Types.ObjectId, ref: "Tenant" },
      name: String,
      email: { type: String, unique: true, lowercase: true },
      password: { type: String, select: false },
      role: {
        type: String,
        enum: [
          "superadmin",
          "owner",
          "manager",
          "cashier",
          "inventory",
          "accountant",
        ],
      },
      permissions: { type: [String], default: undefined },
      active: { type: Boolean, default: true },
      lastLogin: Date,
      tokenVersion: { type: Number, default: 0 },
    },
    opts,
  ),
);
const product = new Schema(
  {
    ...tenant,
    name: { type: String, required: true },
    sku: { type: String, required: true },
    barcode: String,
    category: String,
    brand: String,
    description: String,
    image: String,
    unit: { type: String, default: "Pieces" },
    cost: { type: Number, default: 0 },
    price: { type: Number, default: 0 },
    wholesale: { type: Number, default: 0 },
    stock: { type: Number, default: 0 },
    inventoryValue: { type: Number, default: 0 },
    reorder: { type: Number, default: 5 },
    taxRate: { type: Number, default: 0 },
    taxInclusive: { type: Boolean, default: false },
    hsCode: String,
    saleType: String,
    sroSchedule: String,
    sroItem: String,
    active: { type: Boolean, default: true },
    priceHistory: [Schema.Types.Mixed],
  },
  opts,
);
product.index({ tenant: 1, sku: 1 }, { unique: true });
product.index(
  { tenant: 1, barcode: 1 },
  { unique: true, partialFilterExpression: { barcode: { $type: "string" } } },
);
product.index({ tenant: 1, name: 1 });
export const Product = model("Product", product);
export const Party = model(
  "Party",
  new Schema(
    {
      ...tenant,
      type: { type: String, enum: ["customer", "supplier"], required: true },
      name: { type: String, required: true },
      phone: String,
      address: String,
      email: String,
      ntn: String,
      province: String,
      registrationType: { type: String, default: "Unregistered" },
      creditLimit: { type: Number, default: 0 },
      notes: String,
      balance: { type: Number, default: 0 },
      active: { type: Boolean, default: true },
    },
    opts,
  ),
);
const document = new Schema(
  {
    ...tenant,
    kind: {
      type: String,
      enum: [
        "sale",
        "purchase",
        "sale-return",
        "purchase-return",
        "payment",
        "expense",
        "adjustment",
      ],
      required: true,
    },
    number: String,
    key: { type: String, required: true },
    date: { type: Date, default: Date.now, index: true },
    party: { type: Schema.Types.ObjectId, ref: "Party" },
    partyName: String,
    original: { type: Schema.Types.ObjectId, ref: "Document" },
    items: [
      {
        product: Schema.Types.ObjectId,
        name: String,
        sku: String,
        category: String,
        quantity: Number,
        rate: Number,
        cost: Number,
        extendedCost: Number,
        taxRate: Number,
        taxInclusive: Boolean,
        net: Number,
        tax: Number,
        total: Number,
        returned: { type: Number, default: 0 },
        restock: { type: Boolean, default: true },
        fbr: Schema.Types.Mixed,
      },
    ],
    net: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    cost: { type: Number, default: 0 },
    paid: { type: Number, default: 0 },
    payments: [{ account: String, amount: Number }],
    notes: String,
    category: String,
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    reversed: { type: Boolean, default: false },
    fbrStatus: { type: String, default: "Not Configured" },
  },
  opts,
);
document.index({ tenant: 1, key: 1 }, { unique: true });
document.index({ tenant: 1, number: 1 }, { unique: true });
document.index({ tenant: 1, kind: 1, date: -1 });
export const Document = model("Document", document);
export const Ledger = model(
  "Ledger",
  new Schema(
    {
      ...tenant,
      document: Schema.Types.ObjectId,
      date: { type: Date, default: Date.now },
      account: String,
      party: Schema.Types.ObjectId,
      debit: { type: Number, default: 0 },
      credit: { type: Number, default: 0 },
      description: String,
    },
    opts,
  ),
);
export const Movement = model(
  "Movement",
  new Schema(
    {
      ...tenant,
      product: Schema.Types.ObjectId,
      document: Schema.Types.ObjectId,
      quantity: Number,
      before: Number,
      after: Number,
      cost: Number,
      reason: String,
      user: Schema.Types.ObjectId,
    },
    opts,
  ),
);
export const Sequence = model(
  "Sequence",
  new Schema({
    tenant: { type: Schema.Types.ObjectId, required: true, unique: true },
    value: { type: Number, default: 0 },
  }),
);
export const Audit = model(
  "Audit",
  new Schema(
    {
      tenant: Schema.Types.ObjectId,
      user: Schema.Types.ObjectId,
      action: String,
      entity: String,
      details: Schema.Types.Mixed,
    },
    opts,
  ),
);
export const Refresh = model(
  "Refresh",
  new Schema({
    user: Schema.Types.ObjectId,
    hash: String,
    expires: { type: Date, index: { expires: 0 } },
  }),
);
export const FbrConfig = model(
  "FbrConfig",
  new Schema(
    {
      ...tenant,
      environment: { type: String, default: "sandbox" },
      enabled: Boolean,
      token: String,
      ntn: String,
      province: String,
      address: String,
      businessName: String,
      scenarioId: String,
    },
    opts,
  ),
);
export const FbrSubmission = model(
  "FbrSubmission",
  new Schema(
    {
      ...tenant,
      document: { type: Schema.Types.ObjectId, unique: true },
      status: String,
      environment: String,
      invoiceNumber: String,
      payload: Schema.Types.Mixed,
      response: Schema.Types.Mixed,
      error: String,
      attempts: { type: Number, default: 0 },
      lockedAt: Date,
    },
    opts,
  ),
);
export const ImportJob = model(
  "ImportJob",
  new Schema(
    { ...tenant, user: Schema.Types.ObjectId, summary: Schema.Types.Mixed },
    opts,
  ),
);
