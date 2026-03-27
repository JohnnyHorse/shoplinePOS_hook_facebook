const functions = require('@google-cloud/functions-framework');
const axios = require('axios');
const crypto = require('crypto');

// 由 Secret Manager 注入
const API_VERSION = 'v25.0';
const PIXEL_ID = process.env.FB_PIXEL_ID;
const ACCESS_TOKEN = process.env.FB_ACCESS_TOKEN;

// SHA256 加密函式
const hashData = (data) =>
  typeof data === 'string' && data.trim() !== ''
    ? crypto.createHash('sha256').update(data.trim().toLowerCase(), 'utf8').digest('hex')
    : null;

// 標準化電話號碼
const formatPhoneNumber = (phone, countryCode) => {
  if (!phone || typeof phone !== 'string') return null;

  let cleanedPhone = phone.replace(/\D/g, '');
  cleanedPhone = cleanedPhone.replace(/^0+/, '');

  return cleanedPhone ? `${countryCode}${cleanedPhone}` : null;
};

// 標準化姓名
const formatName = (name) => {
  if (!name || typeof name !== 'string') return null;
  return name.trim().toLowerCase().normalize('NFC');
};

functions.http('shp_FB', async (req, res) => {
  try {
    const orderData = req.body.resource;

    if (!orderData) {
      console.error('No orderData in req.body.resource');
      return res.status(400).json({ success: false, message: 'No order data' });
    }

    // 超過 7 天的事件 Meta 不收
    const eventTime = Math.floor(new Date(orderData.created_at).getTime() / 1000);
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    if (eventTime < sevenDaysAgo) {
      console.log('Event time is too old, skipping event.');
      return res.status(200).json({ success: true, message: 'Event time too old' });
    }

    // 只接受 POS 訂單，其餘所有來源一律略過
    const createdBy = orderData.created_by;
    if (createdBy !== 'pos') {
      console.log(`Order from non-pos source (${createdBy || 'unknown'}), skipping event.`);
      return res.status(200).json({ success: true, message: 'Only POS orders are processed.' });
    }

    const hashedEmail = hashData(orderData.customer_email);
    const formattedPhone = formatPhoneNumber(
      orderData.customer_phone,
      orderData.customer_phone_country_code || '886'
    );
    const hashedPhone = formattedPhone ? hashData(formattedPhone) : null;
    const formattedName = formatName(orderData.customer_name);
    const hashedName = formattedName ? hashData(formattedName) : null;

    if (!hashedEmail && !hashedPhone) {
      console.log('No valid user data. Skipping Facebook event.');
      return res.status(200).json({ success: true, message: 'There is no valid user data.' });
    }

    const fbEvent = {
      data: [
        {
          event_name: 'Purchase',
          event_time: eventTime,
          event_id: orderData.id,
          action_source: 'physical_store',
          user_data: {
            em: hashedEmail ? [hashedEmail] : [],
            ph: hashedPhone ? [hashedPhone] : [],
            fn: hashedName ? [hashedName] : [],
          },
          custom_data: {
            currency: orderData.checkout_object_data?.current_total?.currency_iso || 'TWD',
            value: orderData.checkout_object_data?.current_total?.dollars || 0,
          },
        },
      ],
    };

    const fbUrl = `https://graph.facebook.com/${API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;
    const response = await axios.post(fbUrl, fbEvent, {
      headers: { 'Content-Type': 'application/json' },
    });

    console.log('Sent event to Facebook:', JSON.stringify(response.data));
    return res.status(200).json({ success: true, message: 'Success' });
  } catch (error) {
    const errorDetail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('Error sending to Facebook:', errorDetail);

    // 仍回傳 200，避免 SHOPLINE 重送
    return res.status(200).json({ success: true, error: 'Internal process logged.' });
  }
});
