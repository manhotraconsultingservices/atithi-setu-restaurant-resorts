import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Today's date in India (Asia/Kolkata, UTC+5:30). toISOString() gives the UTC
// date, which is still yesterday between 00:00 and 05:30 IST — date pickers
// defaulted to yesterday and the entry was booked on the wrong day.
export function todayIST(): string {
  return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
}
