import twilio from 'twilio';
import nodemailer from 'nodemailer';

const twilioClient = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN 
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN) 
  : null;

const mailTransporter = process.env.SMTP_HOST 
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

export async function sendSMS(to: string, message: string) {
  if (!twilioClient) {
    console.warn('Twilio not configured. Skipping SMS.');
    return;
  }
  try {
    await twilioClient.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to
    });
  } catch (err) {
    console.error('Failed to send SMS:', err);
  }
}

export async function sendWhatsApp(to: string, message: string) {
  if (!twilioClient) {
    console.warn('Twilio not configured. Skipping WhatsApp.');
    return;
  }
  try {
    await twilioClient.messages.create({
      body: message,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`
    });
  } catch (err) {
    console.error('Failed to send WhatsApp:', err);
  }
}

export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  if (!mailTransporter) {
    console.warn('SMTP not configured. Skipping Email.');
    return;
  }
  try {
    await mailTransporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
      html
    });
  } catch (err) {
    console.error('Failed to send Email:', err);
  }
}
