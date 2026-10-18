import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { User, Tenant, Refresh } from "./models.js";
export const hash = (v) => crypto.createHash("sha256").update(v).digest("hex");
export const roles = {
  owner: ["*"],
  manager: [
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
  ],
  cashier: ["sales", "parties"],
  inventory: ["products", "purchases", "stock"],
  accountant: ["reports", "parties", "payments", "expenses", "fbr"],
};
export function permitted(user, p) {
  return (
    user.role === "superadmin" ||
    user.role === "owner" ||
    (Array.isArray(user.permissions)
      ? user.permissions
      : roles[user.role] || []
    ).includes(p)
  );
}
export const permit = (p) => (req, res, next) =>
  permitted(req.user, p)
    ? next()
    : res.status(403).json({ error: "Permission denied" });
export async function auth(req, res, next) {
  try {
    const token = req.cookies.access;
    const claim = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(claim.sub);
    if (!user || !user.active || claim.v !== user.tokenVersion) throw Error();
    req.user = user;
    if (user.role !== "superadmin") {
      const t = await Tenant.findById(user.tenant);
      if (!t || t.status !== "active" || (t.expires && t.expires < new Date()))
        return res.status(403).json({
          error: "Shop subscription inactive. Contact Ahmed Solutions.",
        });
      req.tenant = t;
    }
    next();
  } catch {
    res.status(401).json({ error: "Please sign in" });
  }
}
export function publicUser(u) {
  return {
    _id: u._id,
    name: u.name,
    email: u.email,
    role: u.role,
    tenant: u.tenant,
    permissions: Array.isArray(u.permissions)
      ? u.permissions
      : roles[u.role] || [],
  };
}
export async function issue(res, user) {
  const raw = crypto.randomBytes(48).toString("hex");
  await Refresh.create({
    user: user._id,
    hash: hash(raw),
    expires: new Date(Date.now() + 7 * 86400000),
  });
  const cookie = {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/api",
  };
  res.cookie(
    "access",
    jwt.sign({ sub: user.id, v: user.tokenVersion }, process.env.JWT_SECRET, {
      expiresIn: "15m",
    }),
    { ...cookie, maxAge: 900000 },
  );
  res.cookie("refresh", raw, { ...cookie, maxAge: 7 * 86400000 });
}
