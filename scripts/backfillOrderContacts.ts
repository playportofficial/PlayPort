/**
 * Backfill customer contact (name, phone, door notes) on open orders that were
 * booked before the order carried it. Riders need a number to call at the door;
 * new bookings get it from createBooking / claimRun, this fills the old ones.
 *
 * Usage:
 *   npm run firebase:backfill:contacts          # dry run — prints what would change
 *   npm run firebase:backfill:contacts -- --apply   # writes to Firestore
 */
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type DocumentData } from 'firebase-admin/firestore';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

function initAdmin() {
  if (getApps().length) return getApps()[0]!;

  const saPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    resolve(process.cwd(), 'serviceAccount.json');

  if (existsSync(saPath) && saPath.endsWith('.json')) {
    const json = JSON.parse(readFileSync(saPath, 'utf8'));
    return initializeApp({
      credential: cert(json),
      projectId: json.project_id || 'playport-fd57f',
    });
  }

  return initializeApp({
    credential: applicationDefault(),
    projectId: process.env.GCLOUD_PROJECT || 'playport-fd57f',
  });
}

const db = getFirestore(initAdmin());

type Contact = {
  customerName?: string;
  customerPhone?: string;
  addressInstructions?: string;
};

function cleanPhone(phone: unknown): string | undefined {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `+91${digits.slice(-10)}` : undefined;
}

function cleanText(value: unknown, max: number): string | undefined {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  return text || undefined;
}

function contactFromAddress(data: DocumentData): Contact {
  const contact: Contact = {};
  const name = cleanText(data.contactName, 60);
  const phone = cleanPhone(data.phone);
  const instructions = cleanText(data.instructions, 240);
  if (name) contact.customerName = name;
  if (phone) contact.customerPhone = phone;
  if (instructions) contact.addressInstructions = instructions;
  return contact;
}

function addressText(data: DocumentData): string {
  return [data.line1, data.line2, data.area, data.city, data.pincode]
    .filter(Boolean)
    .join(', ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

async function resolveContact(order: DocumentData): Promise<Contact> {
  const uid = order.userId as string | undefined;
  if (!uid) return {};

  const addresses = await db.collection('users').doc(uid).collection('addresses').get();

  if (order.addressId) {
    const exact = addresses.docs.find((d) => d.id === order.addressId);
    const contact = exact ? contactFromAddress(exact.data()) : {};
    if (contact.customerPhone) return contact;
  }

  const target = String(order.addressFull ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  let fallback: Contact = {};
  for (const doc of addresses.docs) {
    const data = doc.data();
    const contact = contactFromAddress(data);
    if (target && addressText(data) === target && contact.customerPhone) return contact;
    // Default address is a safe fallback for who to call, never for door notes.
    if (data.isDefault === true && contact.customerPhone) {
      fallback = { customerName: contact.customerName, customerPhone: contact.customerPhone };
    }
  }
  if (fallback.customerPhone) return fallback;

  const profile = (await db.collection('users').doc(uid).get()).data();
  const contact: Contact = {};
  const name = cleanText(profile?.name, 60);
  const phone = cleanPhone(profile?.phone);
  if (name) contact.customerName = name;
  if (phone) contact.customerPhone = phone;
  return contact;
}

async function main() {
  const apply = process.argv.slice(2).includes('--apply');
  const snap = await db.collection('orders').get();

  let scanned = 0;
  let changed = 0;
  for (const doc of snap.docs) {
    const order = doc.data();
    if (['completed', 'cancelled', 'refunded'].includes(String(order.status))) continue;
    if (order.customerPhone && order.customerName) continue;
    scanned += 1;

    const contact = await resolveContact(order);
    const patch: DocumentData = {};
    if (!order.customerName && contact.customerName) patch.customerName = contact.customerName;
    if (!order.customerPhone && contact.customerPhone) patch.customerPhone = contact.customerPhone;
    if (!order.addressInstructions && contact.addressInstructions) {
      patch.addressInstructions = contact.addressInstructions;
    }
    if (!Object.keys(patch).length) {
      console.log(`– ${doc.id}: no contact found`);
      continue;
    }

    changed += 1;
    const who = [patch.customerName, patch.customerPhone].filter(Boolean).join(' · ');
    console.log(`${apply ? '✓' : '·'} ${doc.id}: ${who || '(name/phone already set)'}`);
    if (apply) {
      await doc.ref.update({ ...patch, updatedAt: new Date().toISOString() });
    }
  }

  console.log(
    `\nScanned ${scanned} open orders without contact — ${changed} ${apply ? 'updated' : 'would update'}.` +
      (apply ? '' : '\nRe-run with --apply to write these to Firestore.')
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
