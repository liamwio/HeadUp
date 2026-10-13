package com.headup.growth;

import android.content.Context;
import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "HeadUpDevice")
public class HeadUpDevicePlugin extends Plugin {
    private ExportController exporter;
    private PhotoDirectoryController photos;
    @Override public void load() { exporter = ((MainActivity)getActivity()).exporter; photos = new PhotoDirectoryController(getContext()); }
    private String origin() { return getContext().getSharedPreferences("headup-native", Context.MODE_PRIVATE).getString("server", ""); }
    @PluginMethod public void getServer(PluginCall call) { call.resolve(new JSObject().put("origin", "")); }
    @PluginMethod public void saveServer(PluginCall call) { call.reject("当前版本已关闭家庭服务。"); }
    @PluginMethod public void openServer(PluginCall call) { call.reject("当前版本已关闭家庭服务。"); }
    private ExportController.Reply reply(PluginCall call) { return new ExportController.Reply() { public void resolve(JSObject value) { call.resolve(value); } public void reject(String message) { call.reject(message); } }; }
    @PluginMethod public void beginExport(PluginCall call) { exporter.begin(call.getString("name", "headup-export"), call.getString("mime", "application/octet-stream"), call.getLong("size", -1L), reply(call)); }
    @PluginMethod public void appendExport(PluginCall call) { exporter.append(call.getString("token", ""), call.getString("data", ""), reply(call)); }
    @PluginMethod public void finishExport(PluginCall call) { exporter.finish(call.getString("token", ""), reply(call)); }
    @PluginMethod public void abortExport(PluginCall call) { exporter.abort(call.getString("token", "")); call.resolve(); }
    @PluginMethod public void photoDirectory(PluginCall call) {
        try { call.resolve(photos.location(call.getString("profileId"), call.getString("profileName"))); }
        catch (Exception error) { call.reject(error.getMessage()); }
    }
    @PluginMethod public void beginPhotoCopy(PluginCall call) {
        // JSON stores ordinary image sizes as Integer; PluginCall.getLong only accepts Long.
        photos.begin(call.getString("profileId"), call.getString("profileName"), call.getString("sessionId"), call.getString("date"), call.getString("view"), call.getString("variant"), call.getString("mime"), PhotoPathRules.byteCount(call.getData().opt("size")), call.getString("sha256"), reply(call));
    }
    @PluginMethod public void appendPhotoCopy(PluginCall call) { photos.append(call.getString("token", ""), call.getString("data", ""), reply(call)); }
    @PluginMethod public void finishPhotoCopy(PluginCall call) { photos.finish(call.getString("token", ""), reply(call)); }
    @PluginMethod public void abortPhotoCopy(PluginCall call) { photos.abort(call.getString("token", "")); call.resolve(); }
    @Override protected void handleOnDestroy() { if (exporter != null) exporter.close(); if (photos != null) photos.close(); }
}
