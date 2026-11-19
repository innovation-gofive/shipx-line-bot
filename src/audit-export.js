const writeExcelFile = require('write-excel-file/node').default;
const { NOTIFICATION_TIME_ZONE } = require('./notification-time');

const timestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: NOTIFICATION_TIME_ZONE, dateStyle: 'short', timeStyle: 'medium',
});

function auditWorkbook(rows) {
  const columns = [
    ['เวลา (Asia/Bangkok)', 24], ['กิจกรรม', 31], ['ผู้ดำเนินการ', 40], ['LINE Group ID', 40],
    ['Company ID', 14], ['บริษัท', 30], ['คำถามจากผู้ใช้', 65], ['เลขอ้างอิง', 26], ['API', 51], ['ผลลัพธ์', 24], ['รายละเอียด', 34],
  ];
  const data = [columns.map(([value]) => ({ value, fontWeight: 'bold', textColor: '#FFFFFF', backgroundColor: '#15365B' }))];
  for (const row of rows) {
    data.push([timestamp.format(row.at), row.action, row.actor || 'System', row.group_id,
      row.company_id, row.company_name, row.question, row.reference, row.endpoint, row.outcome, row.detail]);
  }
  return writeExcelFile(data, { sheet: 'Audit Log', columns: columns.map(([, width]) => ({ width })), stickyRowsCount: 1 }).toBuffer();
}

module.exports = { auditWorkbook };
