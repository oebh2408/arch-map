import nodemailer from 'nodemailer';
import { findOrder } from '@shop/db';

const mail = nodemailer.createTransport({ host: 'localhost' });

export async function sendReceipt(job: { data: { orderId: string } }) {
  const order = await findOrder(job.data.orderId);
  await mail.sendMail({ to: order.email, subject: 'Your receipt', text: `Order ${order.id}` });
}
