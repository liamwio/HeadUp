package com.headup.growth;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import com.getcapacitor.JSObject;
import java.io.OutputStream;
import java.util.UUID;

/** Writes only to a document explicitly selected by the user; never accepts filesystem paths. */
final class ExportController {
    interface Reply { void resolve(JSObject value); void reject(String message); }
    private final AppCompatActivity activity;
    private final ActivityResultLauncher<Intent> picker;
    private Reply pending;
    private OutputStream output;
    private Uri destination;
    private String token;
    private long expected, written;
    private boolean closed, pickerOpen;
    ExportController(AppCompatActivity activity) {
        this.activity = activity;
        picker = activity.registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            Reply reply = pending; pending = null; pickerOpen = false;
            if (reply == null) {
                try { if(result.getResultCode()==Activity.RESULT_OK&&result.getData()!=null&&result.getData().getData()!=null)activity.getContentResolver().delete(result.getData().getData(),null,null); } catch(Exception ignored) {}
                return;
            }
            if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) { reply.reject("已取消保存，原记录仍保留。"); return; }
            try {
                if (closed) throw new Exception();
                destination = result.getData().getData();
                output = activity.getContentResolver().openOutputStream(destination, "w");
                if (output == null) throw new Exception();
                token = UUID.randomUUID().toString(); written = 0;
                reply.resolve(new JSObject().put("token", token));
            } catch (Exception error) { abortInternal(); reply.reject("无法写入所选位置，请选择其他目录。"); }
        });
    }
    void begin(String name, String mime, long size, Reply reply) {
        activity.runOnUiThread(() -> {
            if (closed || pickerOpen || pending != null || output != null) { reply.reject("已有文件正在保存，请稍后再试。"); return; }
            if (size < 0 || size > 64L * 1024 * 1024) { reply.reject("请使用64MB以内的文件或分卷备份。"); return; }
            String safeName = name == null ? "headup-export" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_");
            if (safeName.length() > 160) safeName = safeName.substring(0, 160);
            expected = size; pending = reply; pickerOpen = true;
            Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime).putExtra(Intent.EXTRA_TITLE, safeName);
            try { picker.launch(intent); } catch (Exception error) { pending = null; pickerOpen = false; reply.reject("无法打开系统文件保存器。"); }
        });
    }
    synchronized void append(String requestedToken, String data, Reply reply) {
        if (output == null || token == null || !token.equals(requestedToken)) { reply.reject("保存会话已结束。"); return; }
        try {
            if (data == null || data.length() > 300000) throw new Exception();
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (written + bytes.length > expected) throw new Exception();
            output.write(bytes); written += bytes.length; reply.resolve(new JSObject());
        } catch (Exception error) { abortInternal(); reply.reject("文件未完整保存，请保留原资料并重试。"); }
    }
    synchronized void finish(String requestedToken, Reply reply) {
        if (output == null || token == null || !token.equals(requestedToken)) { reply.reject("保存会话已结束。"); return; }
        try {
            if (written != expected) throw new Exception();
            output.close(); output = null; destination = null; token = null; reply.resolve(new JSObject());
        } catch (Exception error) { abortInternal(); reply.reject("文件未完整保存，请重新导出。"); }
    }
    synchronized void abort(String requestedToken) { if (token != null && token.equals(requestedToken)) abortInternal(); }
    private void abortInternal() {
        try { if (output != null) output.close(); } catch (Exception ignored) {}
        output = null; token = null;
        try { if (destination != null) activity.getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
        destination = null;
    }
    synchronized void reset() { abortInternal(); if (pending != null) pending.reject("页面已变化，未保存文件。"); pending = null; }
    synchronized void close() { closed = true; reset(); }
}
