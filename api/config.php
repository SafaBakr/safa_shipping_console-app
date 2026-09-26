<?php
// ======================================================
//  إعدادات نظام الدخول — عدّل هذا الملف فقط
// ======================================================

// البريد الذي تصله طلبات التسجيل الجديدة ورموز التفعيل
const ADMIN_EMAIL = 'safabakr6.2@gmail.com';

// اسم النظام كما يظهر في الرسائل
const SITE_NAME = 'Safa Shipping Console';

// إعدادات إرسال البريد عبر Gmail SMTP
// SMTP_PASS = "كلمة مرور التطبيق" من Google (16 حرفاً) وليس كلمة مرور Gmail العادية.
// راجع ملف README لطريقة إنشائها.
const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const SMTP_USER = 'safabakr6.2@gmail.com';
const SMTP_PASS = '';            // ← ضع كلمة مرور التطبيق هنا
const SMTP_FROM_NAME = 'Safa Shipping Console';

// مدة صلاحية الرموز (بالدقائق)
const SIGNUP_CODE_MINUTES = 1440; // 24 ساعة، لإعطائك وقتاً لإرسال الرمز للمستخدم
const RESET_CODE_MINUTES  = 15;

// إذا كانت SMTP_PASS فارغة تُكتب الرسائل في api/data/mail.log بدلاً من إرسالها (للتجربة فقط)
