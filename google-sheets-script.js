// ═══════════════════════════════════════════════════════════
// Google Apps Script для логування діалогів бота в Google Sheets
//
// ІНСТРУКЦІЯ:
// 1. Створіть нову Google Таблицю
// 2. Додайте заголовки в перший рядок:
//    A: Дата/Час | B: ID клієнта | C: Повідомлення клієнта | D: Відповідь бота |
//    E: Час відповіді (мс) | F: Передача менеджеру | G: Сигнал замовлення | H: Пропущено
// 3. Відкрийте Extensions → Apps Script
// 4. Вставте цей код
// 5. Натисніть Deploy → New deployment → Web app
//    - Execute as: Me
//    - Who has access: Anyone
// 6. Скопіюйте URL і додайте на Railway як GOOGLE_SHEET_WEBHOOK
// ═══════════════════════════════════════════════════════════

function doPost(e) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    var data = JSON.parse(e.postData.contents);

    sheet.appendRow([
      data.timestamp || new Date().toISOString(),
      data.clientId || "",
      data.clientMessage || "",
      data.botResponse || "",
      data.responseTimeMs || 0,
      data.handoff ? "ТАК" : "",
      data.orderSignal ? "ТАК" : "",
      data.skipped ? data.skipReason : "",
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
