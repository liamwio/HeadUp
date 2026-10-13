package com.headup.growth;
import org.junit.Test;
import static org.junit.Assert.*;

public class PhotoPathRulesTest {
    @Test public void acceptsJsonIntegerPhotoSizesAndRejectsInvalidSizes() {
        assertEquals(123456L, PhotoPathRules.byteCount(Integer.valueOf(123456)));
        assertEquals(123456L, PhotoPathRules.byteCount(Long.valueOf(123456)));
        assertEquals(30L * 1024 * 1024, PhotoPathRules.byteCount(30 * 1024 * 1024));
        for (Object invalid : new Object[]{null, "123", 0, -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY, 30L * 1024 * 1024 + 1}) {
            assertEquals(-1L, PhotoPathRules.byteCount(invalid));
        }
    }
    @Test public void keepsProfilesSeparateAndSanitizesNames() {
        assertEquals("A_B_C_profile-1", PhotoPathRules.folder("profile-1", "A/B\\C"));
        assertNotEquals(PhotoPathRules.folder("profile-1", "同名"), PhotoPathRules.folder("profile-2", "同名"));
        assertFalse(PhotoPathRules.folder("profile-1", "../../").contains("/"));
    }
    @Test public void rejectsPathsInsteadOfTreatingIdsAsDirectories() {
        for (String id : new String[]{"../x", "/sdcard", "a:b", "", "a\\b"}) {
            try { PhotoPathRules.folder(id, "name"); fail("accepted invalid id"); }
            catch (IllegalArgumentException expected) { }
        }
    }
    @Test public void namesFilesByDateRecordViewAndOriginalOrAnalysis() {
        String hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        String original = PhotoPathRules.fileName("session-1", "2026-10-12", "left", "original", hash, "image/png");
        assertTrue(original.contains("2026-10-12_session-1_左侧_原图_0123456789ab"));
        assertTrue(original.endsWith(".png"));
        assertNotEquals(original, PhotoPathRules.fileName("session-1", "2026-10-12", "left", "analysis", hash, "image/png"));
        try { PhotoPathRules.fileName("session-1", "2026-10-12", "left", "original", hash, "text/html"); fail(); }
        catch (IllegalArgumentException expected) { }
    }
}
