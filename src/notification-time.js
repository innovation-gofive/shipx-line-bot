const DEFAULT_NOTIFICATION_TIME = '16:00';
const DEFAULT_SHIPPING_SUMMARY_TIME = '18:00';
const NOTIFICATION_TIME_ZONE = 'Asia/Bangkok';

function isNotificationTime(value) {
  return typeof value === 'string' && value.length === 5 && /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

module.exports = { DEFAULT_NOTIFICATION_TIME, DEFAULT_SHIPPING_SUMMARY_TIME, NOTIFICATION_TIME_ZONE, isNotificationTime };
