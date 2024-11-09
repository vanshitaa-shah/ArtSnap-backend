const cors = require('cors');
const express = require('express');
const admin = require('firebase-admin');
const webpush = require('web-push');
const formidable = require('formidable');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Storage } = require('@google-cloud/storage');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Initialize Google Cloud Storage
const gcs = new Storage({
  projectId: process.env.GCLOUD_PROJECT,
  keyFilename: process.env.GCLOUD_KEYFILE,
});

// Initialize Firebase if not already initialized
if (!admin.apps.length) {
  const serviceAccount = require('./pwagram-fb-key.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.DATABASE_URL,
  });
}

// Handle push notifications
const sendPushNotifications = async (subscriptions) => {
  if (!subscriptions) return;

  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const notifications = Object.values(subscriptions).map(subscription => {
    const pushConfig = {
      endpoint: subscription.endpoint,
      keys: {
        auth: subscription.keys.auth,
        p256dh: subscription.keys.p256dh,
      },
    };

    return webpush.sendNotification(
      pushConfig,
      JSON.stringify({
        title: 'New post',
        content: 'New post added',
        url: '/help',
      })
    );
  });

  return Promise.allSettled(notifications);
};

app.post('/postArt', async (request, response) => {
  const form = new formidable.IncomingForm();

  try {
    const [fields, files] = await form.parse(request);
    const artImage = files.artImage[0];
    const tempPath = '/tmp/' + artImage.originalFilename;

    await fs.promises.rename(artImage.filepath, tempPath);

    const bucket = gcs.bucket('pwagram-14946.appspot.com');
    const uuid = uuidv4();

    // Upload to Google Cloud Storage
    const [file] = await bucket.upload(tempPath, {
      uploadType: 'media',
      metadata: {
        metadata: {
          contentType: artImage.mimetype,
          firebaseStorageDownloadTokens: uuid,
        },
      },
    });

    const imageUrl = `https://firebasestorage.googleapis.com/v0/b/${
      bucket.name
    }/o/${encodeURIComponent(file.name)}?alt=media&token=${uuid}`;

    // Store art data in Firebase
    await admin.database().ref('arts').child(uuid).set({
      id: fields.id,
      artName: fields.artName,
      artistName: fields.artistName,
      description: fields.description,
      imageUrl,
    });

    const subscriptionsSnapshot = await admin
      .database()
      .ref('subscriptions')
      .once('value');

    await sendPushNotifications(subscriptionsSnapshot.val());

    response.status(201).json({ 
      message: 'Art stored successfully', 
      id: fields.id 
    });

  } catch (error) {
    console.error('Error processing art upload:', error);
    response.status(500).json({ 
      error: 'Error processing art upload',
      details: error.message || 'Unknown error'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
