package com.headup.growth;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.UUID;

/** Own-image copies only. Does not request access to the user's whole library. */
final class PhotoDirectoryController {
    private final Context context;
    private final SharedPreferences preferences;
    private OutputStream output;
    private Uri destination;
    private File legacyFile, legacyTarget;
    private String token, expectedHash, directory, cacheKey;
    private MessageDigest digest;
    private long expected, written;
    private boolean closed;

    PhotoDirectoryController(Context context) {
        this.context = context.getApplicationContext();
        this.preferences = context.getSharedPreferences("headup-photo-directory", Context.MODE_PRIVATE);
        String legacyPending = preferences.getString("legacyPending", null);
        if (legacyPending != null) {
            try {
                File base = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES), staleFile = new File(legacyPending);
                if (base != null && staleFile.getCanonicalPath().startsWith(new File(base, "HeadUp").getCanonicalPath() + File.separator) && staleFile.getName().startsWith(".pending-")) staleFile.delete();
            } catch (Exception ignored) { }
            preferences.edit().remove("legacyPending").apply();
        }
        String stale = preferences.getString("pending", null);
        if (stale != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Uri uri = Uri.parse(stale);
            try (Cursor c = context.getContentResolver().query(uri, new String[]{MediaStore.Images.Media.IS_PENDING}, null, null, null)) {
                if (c != null && c.moveToFirst() && c.getInt(0) == 1) context.getContentResolver().delete(uri, null, null);
            } catch (Exception ignored) { /* A missing old pending row is harmless. */ }
            preferences.edit().remove("pending").apply();
        }
    }
    private String folder(String id, String name) {
        PhotoPathRules.id(id);
        String key = "folder:" + id, saved = preferences.getString(key, null);
        if (saved != null) return saved;
        String value = PhotoPathRules.folder(id, name);
        if (!preferences.edit().putString(key, value).commit()) throw new IllegalStateException("无法记录照片目录，请稍后重试");
        return value;
    }
    synchronized JSObject location(String id, String name) {
        String subfolder = folder(id, name);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) return new JSObject().put("directory", "Pictures/HeadUp/" + subfolder + "/").put("shared", true);
        File base = context.getExternalFilesDir(Environment.DIRECTORY_PICTURES);
        if (base == null) throw new IllegalStateException("手机存储暂不可用");
        return new JSObject().put("directory", new File(base, "HeadUp/" + subfolder).getAbsolutePath()).put("shared", false);
    }
    synchronized void begin(String profileId, String profileName, String sessionId, String date, String view, String variant, String mime, long size, String hash, ExportController.Reply reply) {
        if (closed || output != null) { reply.reject("照片正在归档，请稍后重试"); return; }
        try {
            if (size <= 0 || size > 30L * 1024 * 1024) throw new IllegalArgumentException("照片为空或超过30MB");
            String name = PhotoPathRules.fileName(sessionId, date, view, variant, hash, mime);
            directory = location(profileId, profileName).getString("directory");
            cacheKey = "photo:" + profileId + ":" + name;
            String cached = preferences.getString(cacheKey, null);
            if (cached != null && matches(Uri.parse(cached), hash)) { reply.resolve(new JSObject().put("alreadySaved", true).put("directory", directory)); return; }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                Uri collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                // Recover a complete copy if the process stopped between publication and receipt persistence.
                try (Cursor c = context.getContentResolver().query(collection, new String[]{MediaStore.Images.Media._ID}, MediaStore.Images.Media.RELATIVE_PATH + "=? AND " + MediaStore.Images.Media.DISPLAY_NAME + "=? AND " + MediaStore.Images.Media.IS_PENDING + "=0", new String[]{directory, name}, null)) {
                    while (c != null && c.moveToNext()) {
                        Uri existing = Uri.withAppendedPath(collection, c.getString(0));
                        if (matches(existing, hash)) { preferences.edit().putString(cacheKey, existing.toString()).apply(); reply.resolve(new JSObject().put("alreadySaved", true).put("directory", directory)); return; }
                    }
                }
                ContentValues values = new ContentValues();
                values.put(MediaStore.Images.Media.DISPLAY_NAME, name); values.put(MediaStore.Images.Media.MIME_TYPE, mime);
                values.put(MediaStore.Images.Media.RELATIVE_PATH, directory); values.put(MediaStore.Images.Media.IS_PENDING, 1);
                destination = context.getContentResolver().insert(collection, values);
                if (destination == null) throw new IllegalStateException("无法创建照片文件");
                if (!preferences.edit().putString("pending", destination.toString()).commit()) throw new IllegalStateException("无法记录保存进度");
                output = context.getContentResolver().openOutputStream(destination, "w");
            } else {
                File folder = new File(directory);
                if (!folder.isDirectory() && !folder.mkdirs()) throw new IllegalStateException("无法创建照片目录");
                File proposed = new File(folder, name);
                if (proposed.exists() && matches(Uri.fromFile(proposed), hash)) { reply.resolve(new JSObject().put("alreadySaved", true).put("directory", directory)); return; }
                if (proposed.exists()) proposed = new File(folder, UUID.randomUUID() + "_" + name);
                legacyTarget = proposed;
                legacyFile = new File(folder, ".pending-" + UUID.randomUUID());
                if (!legacyFile.createNewFile()) throw new IllegalStateException("无法创建照片文件");
                if (!preferences.edit().putString("legacyPending", legacyFile.getAbsolutePath()).commit()) throw new IllegalStateException("无法记录保存进度");
                output = new FileOutputStream(legacyFile);
            }
            if (output == null) throw new IllegalStateException("无法写入照片目录");
            digest = MessageDigest.getInstance("SHA-256"); expectedHash = hash; expected = size; written = 0; token = UUID.randomUUID().toString();
            reply.resolve(new JSObject().put("token", token).put("alreadySaved", false).put("directory", directory));
        } catch (Exception error) { abortInternal(); reply.reject("照片目录写入未完成，应用内记录仍保留：" + error.getMessage()); }
    }
    synchronized void append(String key, String data, ExportController.Reply reply) {
        if (output == null || token == null || !token.equals(key)) { reply.reject("照片保存会话已结束"); return; }
        try {
            if (data == null || data.length() > 262144) throw new IllegalArgumentException();
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            if (bytes.length > 192 * 1024 || written + bytes.length > expected) throw new IllegalArgumentException();
            output.write(bytes); digest.update(bytes); written += bytes.length; reply.resolve(new JSObject());
        } catch (Exception error) { abortInternal(); reply.reject("照片没有完整写入，请重试补存"); }
    }
    synchronized void finish(String key, ExportController.Reply reply) {
        if (output == null || token == null || !token.equals(key)) { reply.reject("照片保存会话已结束"); return; }
        try {
            if (written != expected || !hex(digest.digest()).equals(expectedHash)) throw new IllegalStateException("照片校验未通过");
            output.close(); output = null;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ContentValues values = new ContentValues(); values.put(MediaStore.Images.Media.IS_PENDING, 0);
                if (context.getContentResolver().update(destination, values, null, null) != 1) throw new IllegalStateException("照片发布未完成");
            } else {
                if (legacyTarget.exists() || !legacyFile.renameTo(legacyTarget)) throw new IllegalStateException("照片文件发布未完成");
                legacyFile = legacyTarget; destination = Uri.fromFile(legacyTarget);
            }
            preferences.edit().putString(cacheKey, destination.toString()).remove("pending").remove("legacyPending").apply();
            destination = null; legacyFile = null; legacyTarget = null; token = null; digest = null;
            reply.resolve(new JSObject().put("directory", directory));
        } catch (Exception error) { abortInternal(); reply.reject("照片目录写入未完成，应用内记录仍保留"); }
    }
    synchronized void abort(String key) { if (token != null && token.equals(key)) abortInternal(); }
    private boolean matches(Uri uri, String hash) {
        try (InputStream input = context.getContentResolver().openInputStream(uri)) {
            if (input == null) return false;
            MessageDigest md = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[65536]; int count; long total = 0;
            while ((count = input.read(buffer)) != -1) { total += count; if (total > 30L * 1024 * 1024) return false; md.update(buffer, 0, count); }
            return hex(md.digest()).equals(hash);
        } catch (Exception ignored) { return false; }
    }
    private static String hex(byte[] bytes) { StringBuilder s = new StringBuilder(); for (byte value : bytes) s.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return s.toString(); }
    private void abortInternal() {
        try { if (output != null) output.close(); } catch (Exception ignored) {}
        try { if (legacyFile != null) legacyFile.delete(); else if (destination != null) context.getContentResolver().delete(destination, null, null); } catch (Exception ignored) {}
        output = null; destination = null; legacyFile = null; legacyTarget = null; token = null; digest = null;
        preferences.edit().remove("pending").remove("legacyPending").apply();
    }
    synchronized void close() { closed = true; abortInternal(); }
}
