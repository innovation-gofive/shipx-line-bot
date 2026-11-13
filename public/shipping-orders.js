'use strict';

const report = document.getElementById('shipping-report');
const token = location.hash.slice(1);

function showStatus(message) {
  report.firstElementChild.textContent = message;
}

async function openReport() {
  const unavailable = 'ลิงก์นี้หมดอายุหรือเปิดไม่ได้ กรุณาเปิดการ์ดรายงานล่าสุดจากกลุ่ม LINE';
  try {
    if (!/^[a-f0-9]{64}$/.test(token)) {
      showStatus(unavailable);
      return;
    }
    const response = await fetch(location.pathname, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', credentials: 'omit',
    });
    if (response.status === 404) showStatus(unavailable);
    else if (response.ok) report.innerHTML = await response.text();
    else throw new Error('Report request failed');
  } catch {
    showStatus('เปิดรายการไม่สำเร็จ กรุณาโหลดหน้านี้ใหม่');
  } finally {
    report.removeAttribute('aria-busy');
  }
}

openReport();
