export interface Money {
  amount: number;
  currency: string;
}

export const formatMoney = (m: Money) => `${(m.amount / 100).toFixed(2)} ${m.currency}`;
