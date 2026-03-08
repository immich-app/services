import type { FourthwallOrder, IFourthwallRepository } from '../interfaces/fourthwall.interface.js';

export class FourthwallRepository implements IFourthwallRepository {
  async getOrder({ id, user, password }: { id: string; user: string; password: string }): Promise<FourthwallOrder> {
    const response = await fetch(`https://api.fourthwall.com/api/orders/${id}`, {
      headers: { Authorization: `Basic ${btoa(`${user}:${password}`)}` },
    });
    return response.json() as Promise<FourthwallOrder>;
  }
}
