import Decimal from "decimal.js";
export const cents = (v) => {
  const n = new Decimal(v ?? 0)
    .mul(100)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  if (!Number.isSafeInteger(n)) throw Error("Amount out of range");
  return n;
};
export const round = (v) =>
  new Decimal(v).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
export function line(q, rate, discount = 0, taxRate = 0, inclusive = false) {
  const gross = new Decimal(rate).mul(q).sub(discount);
  if (gross.isNegative()) throw Error("Discount exceeds line value");
  const net = inclusive
    ? gross.div(new Decimal(1).add(new Decimal(taxRate).div(100)))
    : gross;
  const n = round(net),
    tax = round(inclusive ? gross.sub(net) : net.mul(taxRate).div(100));
  return { net: n, tax, total: n + tax };
}
export function allocate(items, discount) {
  let used = 0;
  return items.map((x, i) => {
    const d =
      i === items.length - 1
        ? discount - used
        : round(
            new Decimal(discount)
              .mul(x.net)
              .div(items.reduce((s, a) => s + a.net, 0) || 1),
          );
    used += d;
    return { ...x, ...line(x.quantity, x.rate, d, x.taxRate, x.taxInclusive) };
  });
}
export const sum = (a, key) => a.reduce((s, x) => s + (x[key] || 0), 0);
