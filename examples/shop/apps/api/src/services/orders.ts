import { findOrdersByCustomer, insertOrder } from '@shop/db';
import { newOrder, type OrderInput } from '@shop/domain';

export const listOrders = () => findOrdersByCustomer('all');
export const createOrder = (input: OrderInput) => insertOrder(newOrder(input));
