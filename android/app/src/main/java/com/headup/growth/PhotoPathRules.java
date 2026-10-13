package com.headup.growth;

final class PhotoPathRules {
    private PhotoPathRules() {}
    static long byteCount(Object value) {
        if (!(value instanceof Number)) return -1L;
        double size = ((Number) value).doubleValue();
        if (!Double.isFinite(size) || size <= 0 || size > 30L * 1024 * 1024 || size != Math.floor(size)) return -1L;
        return ((Number) value).longValue();
    }
    static String id(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{1,100}")) throw new IllegalArgumentException("档案或记录编号无效");
        return value;
    }
    static String folder(String profileId, String name) {
        id(profileId);
        String safe = name == null ? "档案" : name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").replaceAll("^\\.+|\\.+$", "").trim();
        if (safe.isEmpty()) safe = "档案";
        if (safe.length() > 40) safe = safe.substring(0, 40);
        return safe + "_" + profileId;
    }
    static String extension(String mime) {
        if ("image/png".equals(mime)) return ".png";
        if ("image/jpeg".equals(mime)) return ".jpg";
        if ("image/webp".equals(mime)) return ".webp";
        if ("image/avif".equals(mime)) return ".avif";
        throw new IllegalArgumentException("照片格式不支持目录保存");
    }
    static String fileName(String sessionId, String date, String view, String variant, String hash, String mime) {
        id(sessionId);
        if (date == null || !date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new IllegalArgumentException("照片日期无效");
        if (hash == null || !hash.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("照片校验码无效");
        String label;
        switch (view == null ? "" : view) {
            case "front": label = "正面"; break;
            case "left": label = "左侧"; break;
            case "right": label = "右侧"; break;
            case "profile": label = "侧面"; break;
            case "top": label = "头顶"; break;
            default: throw new IllegalArgumentException("照片视角无效");
        }
        if (!"original".equals(variant) && !"analysis".equals(variant)) throw new IllegalArgumentException("照片版本无效");
        return "HU_" + date + "_" + sessionId + "_" + label + "_" + ("original".equals(variant) ? "原图" : "分析图") + "_" + hash.substring(0, 12) + extension(mime);
    }
}
