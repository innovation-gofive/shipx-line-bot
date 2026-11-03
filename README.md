# ShipX LINE Bot — รุ่นแรก

App สำหรับให้ลูกค้าสอบถามสถานะ Order ผ่าน LINE Group พร้อมหน้าผู้ดูแลผูก LINE Group ID → ShipX Company ID และ Docker Compose สำหรับ deploy บน Coolify

เริ่มทดลอง:

```powershell
cd C:\ShipX-Line-Bot
npm run demo
```

เปิด `http://localhost:3000` ผู้ใช้ `admin` รหัส demo `shipx-demo-local-2026` ต้องใช้ Node.js 24 ขึ้นไป หากยังไม่มี dependencies รัน `npm ci` ก่อน

อ่าน [คู่มือทดสอบและ deploy](TESTING_GUIDE.md) สำหรับขั้นตอนและผลที่ควรได้ รวมถึงข้อจำกัดของการตรวจสอบที่ทำไปแล้ว

ผล QA ล่าสุด: ผ่านชุดอัตโนมัติ 18 เคส และตรวจหน้าจอ/การแยกบริษัทผ่าน browser แล้ว ดู [รายงาน QA](QA_REPORT.md) สำหรับขอบเขตที่ตรวจจริงและส่วนที่รอตั้งค่าภายนอก

## ขอบเขต API จากไฟล์แนบ

- V1: `GET /api/v1/Company/GetListCompany` อ่าน `data.companies[].companyId/companyName`
- V2: `GET /api/v2/Order/search` ส่ง `searchText`, `companyIds`, `pageNumber`, `pageSize` และอ่าน `data.data[]`, `data.hasMore`
- V3: วิเคราะห์แล้ว แต่ไม่เรียกใช้ในรุ่นแรก เพราะ endpoint รายการ Order ไม่มีช่องค้นหาเลข Order และ endpoint สร้าง Order ไม่อยู่ในขอบเขตงาน
- เอกสารไม่ระบุ server URL; ต้องยืนยัน Base URL และวิธี authentication ก่อนใช้งานจริง ตัว client รองรับส่ง X-API-Key และ Bearer พร้อมกัน

Bot รับเฉพาะคำสั่งที่ระบุเลขชัดเจน เช่น `order SO001`, `สถานะ SO001`, `status TRACK001`, `help` จึงไม่ต้องใช้ AI ในรุ่นนี้

## การแยกบริษัท

1. ตรวจ HMAC-SHA256 จาก raw body ของ LINE ก่อนประมวลผล
2. บันทึกกลุ่มที่ตรวจพบ โดยยังไม่เปิดสิทธิ์จนกว่า Admin จะผูกบริษัท
3. อ่าน Company ID จาก Mapping ฝั่ง server เสมอ ไม่รับ Company ID จากคำสั่งลูกค้า
4. ส่งตัวกรองบริษัทไป ShipX และตรวจ `companyId` ของแต่ละ Order ซ้ำ หากไม่มีหรือไม่ตรงจะไม่แสดง
5. ตรงเลขอ้างอิงทั้งค่าเท่านั้น ส่งกลับเฉพาะเลข Order, statusDescription, tracking และ carrier ไม่เดาความหมายรหัสสถานะ
6. ตรวจ Mapping ซ้ำเมื่อค้นหาเสร็จและก่อนส่ง LINE ถ้าสิทธิ์เปลี่ยนจะยกเลิกข้อมูลเดิม
7. บริษัทหนึ่งเปิดใช้งานได้หนึ่งกลุ่ม; Bot ออกจากกลุ่มจะปิดสิทธิ์อัตโนมัติ

มี login ของ Admin, session cookie, CSRF token, origin check, rate limit, Audit log และ durable webhook inbox ที่ deduplicate ด้วย webhookEventId

## การใช้งานจริง

ตั้งค่าตาม `.env.example` แล้ว `npm start` หรือ deploy ด้วย `docker-compose.yml` ตามคู่มือ ห้าม commit `.env` หรือฐานข้อมูล

- App รันที่ port 3000; health endpoint `/healthz`; LINE endpoint `/webhook`
- SQLite เก็บที่ `/app/data/shipx.sqlite` ใน production ต้องคง volume `shipx-data` และรัน App หนึ่ง replica หลีกเลี่ยงการรัน container สองตัวบนไฟล์เดียวกันพร้อมกัน
- Demo ใช้ `data/demo.sqlite` หรือ `DEMO_DATABASE_PATH` แยกจาก `DATABASE_PATH` ของระบบจริงเสมอ ไม่ตั้งสองค่านี้เป็นไฟล์เดียวกัน
- สำรองข้อมูลโดยหยุด App แล้วสำรองทั้ง volume ก่อนเปิด App ต่อ ห้ามลบ volume เมื่อ redeploy
- session หมดอายุ 8 ชั่วโมงและถูกล้างเมื่อ server restart
- Audit เก็บ 90 วัน; event ID สำหรับ dedup เก็บ 7 วัน; payload/replyToken ถูกล้างเมื่อประมวลผลเสร็จ
- รับ webhook แล้วตอบ 200 หลัง commit inbox งานประมวลผลภายหลัง ข้อมูลสถานะไม่ถูกเก็บเป็น cache
- งานที่ตอบ LINE ไม่สำเร็จบันทึก failed ไม่มี push/retry อัตโนมัติในรุ่นนี้ ผู้ใช้ส่งคำสั่งใหม่ได้; ตรวจ Audit และ queue ในกรณีโหลดสูง
- คิวทำงานตามลำดับและมีเวลาจำกัดของ LINE reply token จึงเหมาะกับการใช้งานรุ่นแรกที่ปริมาณคำขอยังไม่สูง
- สมาชิกทุกคนใน LINE Group มีสิทธิ์บริษัทเดียวกัน ต้องควบคุมสมาชิกกลุ่มด้วย

งานแจ้งเตือนอัตโนมัติ, Stock, Delivery และ Reports จากภาพเป็นส่วนต่อยอด ไม่ได้เปิดใช้งานในรุ่นนี้
