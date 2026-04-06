import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { centralDb } from './db.ts';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

let driveClient: any = null;

function getDriveClient() {
  if (driveClient) return driveClient;

  const credentialsJson = process.env.GOOGLE_DRIVE_CREDENTIALS;
  if (!credentialsJson) {
    console.warn("GOOGLE_DRIVE_CREDENTIALS not set. Google Drive access disabled.");
    return null;
  }

  try {
    const credentials = JSON.parse(credentialsJson);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: SCOPES,
    });
    driveClient = google.drive({ version: 'v3', auth });
    return driveClient;
  } catch (err) {
    console.error("Failed to initialize Google Drive client:", err);
    return null;
  }
}

export async function downloadFromDrive(filename: string, destinationPath: string) {
  const drive = getDriveClient();
  if (!drive) return false;

  try {
    const backup = await centralDb.get("SELECT drive_file_id FROM image_backups WHERE filename = ?", [filename]);
    if (!backup) return false;

    const dest = fs.createWriteStream(destinationPath);
    const response = await drive.files.get(
      { fileId: backup.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    return new Promise((resolve, reject) => {
      response.data
        .on('end', () => {
          console.log(`Downloaded ${filename} from Google Drive`);
          resolve(true);
        })
        .on('error', (err: any) => {
          console.error(`Error downloading ${filename} from Google Drive:`, err);
          reject(err);
        })
        .pipe(dest);
    });
  } catch (err) {
    console.error(`Failed to download ${filename} from Google Drive:`, err);
    return false;
  }
}
