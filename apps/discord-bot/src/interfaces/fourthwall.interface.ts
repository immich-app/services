type Price = { value: number; currency: string };

export interface FourthwallOrder {
  type: string;
  profit: Price;
  id: string;
  friendlyId: string;
  status: string;
  discount: number | null;
  currentAmounts: {
    offers: Price;
    shipping: Price;
    tax: Price;
    discount: Price;
    total: Price;
  };
  totalPrice: Price;
  message?: string;
}

export interface FourthwallOrderCreateWebhook {
  testMode: boolean;
  id: string;
  webhookId: string;
  shopId: string;
  type: 'ORDER_PLACED';
  apiVersion: string;
  createdAt: string;
  data: FourthwallOrderData;
}

interface FourthwallOrderData {
  amounts: { discount: Price; donation: Price; shipping: Price; subtotal: Price; tax: Price; total: Price };
  billing: { address: unknown };
  checkoutId: string;
  createdAt: string;
  email: string;
  emailMarketingOptIn: boolean;
  friendlyId: string;
  id: string;
  message?: string;
  offers: unknown[];
  shipping: { address: unknown };
  shopId: string;
  source: { type: string };
  status: string;
  updatedAt: string;
  username?: string;
}

export interface FourthwallOrderUpdateWebhook {
  testMode: boolean;
  id: string;
  webhookId: string;
  shopId: string;
  type: 'ORDER_UPDATED';
  apiVersion: string;
  createdAt: string;
  data: { order: FourthwallOrderData; update: { type: string } };
}

export interface IFourthwallRepository {
  getOrder(options: { id: string; user: string; password: string }): Promise<FourthwallOrder>;
}
