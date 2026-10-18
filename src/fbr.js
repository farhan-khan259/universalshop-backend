import crypto from "node:crypto";
import {
  FbrConfig,
  FbrSubmission,
  Document,
  Party,
  Tenant,
  Audit,
} from "./models.js";
const key = () =>
  crypto
    .createHash("sha256")
    .update(process.env.FBR_ENCRYPTION_KEY || "")
    .digest();
export function encrypt(s) {
  if (!process.env.FBR_ENCRYPTION_KEY)
    throw Error("Set FBR_ENCRYPTION_KEY on the server");
  const iv = crypto.randomBytes(12),
    c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  return [
    iv.toString("hex"),
    c.update(s, "utf8", "hex") + c.final("hex"),
    c.getAuthTag().toString("hex"),
  ].join(":");
}
function decrypt(s) {
  const [i, v, t] = s.split(":"),
    c = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(i, "hex"));
  c.setAuthTag(Buffer.from(t, "hex"));
  return c.update(v, "hex", "utf8") + c.final("utf8");
}
export function payload(doc, config, party) {
  if (
    !config.ntn ||
    !config.province ||
    !config.address ||
    !config.businessName
  )
    throw Error("Complete seller FBR profile");
  if (!party?.province || !party?.address)
    throw Error("FBR invoice requires buyer address and province");
  return {
    invoiceType: "Sale Invoice",
    invoiceDate: doc.date.toLocaleDateString("en-CA", {
      timeZone: "Asia/Karachi",
    }),
    sellerNTNCNIC: config.ntn,
    sellerBusinessName: config.businessName,
    sellerProvince: config.province,
    sellerAddress: config.address,
    buyerNTNCNIC: party.ntn || "",
    buyerBusinessName: party.name,
    buyerProvince: party.province,
    buyerAddress: party.address,
    buyerRegistrationType: party.registrationType || "Unregistered",
    invoiceRefNo: "",
    ...(config.environment === "sandbox"
      ? { scenarioId: config.scenarioId }
      : {}),
    items: doc.items.map((x) => {
      if (!x.fbr?.hsCode || !x.fbr?.saleType)
        throw Error(`${x.name}: HS code and FBR sale type required`);
      return {
        hsCode: x.fbr.hsCode,
        productDescription: x.name,
        rate: `${x.taxRate}%`,
        uoM: x.fbr.uom,
        quantity: x.quantity,
        totalValues: x.total / 100,
        valueSalesExcludingST: x.net / 100,
        fixedNotifiedValueOrRetailPrice: 0,
        salesTaxApplicable: x.tax / 100,
        salesTaxWithheldAtSource: 0,
        extraTax: 0,
        furtherTax: 0,
        sroScheduleNo: x.fbr.sroSchedule || "",
        fedPayable: 0,
        discount: 0,
        saleType: x.fbr.saleType,
        sroItemSerialNo: x.fbr.sroItem || "",
      };
    }),
  };
}
export async function submit(tenant, id, user, validateOnly = false) {
  const config = await FbrConfig.findOne({ tenant });
  if (!config?.enabled || !config.token)
    throw Object.assign(
      Error("FBR pending activation: configure authorized credentials"),
      { status: 422 },
    );
  const doc = await Document.findOne({ _id: id, tenant, kind: "sale" });
  if (!doc) throw Error("Sale not found");
  const party = await Party.findOne({ _id: doc.party, tenant });
  const data = payload(doc, config, party);
  const url = `https://gw.fbr.gov.pk/di_data/v1/di/${validateOnly ? "validateinvoicedata" : "postinvoicedata"}${config.environment === "sandbox" ? "_sb" : ""}`;
  if (validateOnly) {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decrypt(config.token)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error(`FBR HTTP ${r.status}`);
    return r.json();
  }
  await FbrSubmission.updateOne(
    { tenant, document: doc._id },
    { $setOnInsert: { status: "Pending", environment: config.environment } },
    { upsert: true },
  );
  const job = await FbrSubmission.findOneAndUpdate(
    { tenant, document: doc._id, status: { $in: ["Pending", "Rejected"] } },
    {
      $set: {
        status: "Submitted",
        lockedAt: new Date(),
        payload: data,
        environment: config.environment,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  );
  if (!job)
    throw Object.assign(
      Error(
        "Submission accepted, in progress, or uncertain. Reconcile before retrying.",
      ),
      { status: 409 },
    );
  doc.fbrStatus = "Submitted";
  await doc.save();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${decrypt(config.token)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error(`FBR HTTP ${r.status}`);
    const response = await r.json();
    const accepted =
      response.validationResponse?.statusCode === "00" &&
      !!response.invoiceNumber &&
      Array.isArray(response.validationResponse?.invoiceStatuses) &&
      response.validationResponse.invoiceStatuses.length === doc.items.length &&
      response.validationResponse.invoiceStatuses.every(
        (x) => x.statusCode === "00",
      );
    job.status = accepted ? "Accepted" : "Rejected";
    job.response = response;
    job.invoiceNumber = accepted ? response.invoiceNumber : undefined;
    job.error = accepted
      ? ""
      : response.validationResponse?.error || JSON.stringify(response);
    doc.fbrStatus = job.status;
    await doc.save();
    await job.save();
    await Audit.create({
      tenant,
      user,
      action: "FBR " + job.status,
      entity: doc.id,
    });
    return job;
  } catch (e) {
    job.status = "Retry Required";
    job.error =
      "Outcome uncertain. Confirm with integrator before retry: " + e.message;
    await job.save();
    doc.fbrStatus = "Retry Required";
    await doc.save();
    throw e;
  }
}
export async function processPending() {
  const pending = await Document.find({
    kind: "sale",
    fbrStatus: "Pending",
  }).limit(10);
  for (const d of pending) {
    try {
      await submit(d.tenant, d._id, d.createdBy);
    } catch (e) {
      await Document.updateOne(
        { _id: d._id, fbrStatus: "Pending" },
        { $set: { fbrStatus: "Rejected" } },
      );
    }
  }
  await FbrSubmission.updateMany(
    { status: "Submitted", lockedAt: { $lt: new Date(Date.now() - 120000) } },
    {
      $set: {
        status: "Retry Required",
        error: "Worker interrupted; reconcile with integrator before retry.",
      },
    },
  );
}
