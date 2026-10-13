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
    @Override public void load() { exporter = ((MainActivity)getActivity()).exporter; }
    private String origin() { return getContext().getSharedPreferences("headup-native", Context.MODE_PRIVATE).getString("server", ""); }
    @PluginMethod public void getServer(PluginCall call) { call.resolve(new JSObject().put("origin", "")); }
    @PluginMethod public void saveServer(PluginCall call) { call.reject("当前版本已关闭家庭服务。"); }
    @PluginMethod public void openServer(PluginCall call) { call.reject("当前版本已关闭家庭服务。"); }
    private ExportController.Reply reply(PluginCall call) { return new ExportController.Reply() { public void resolve(JSObject value) { call.resolve(value); } public void reject(String message) { call.reject(message); } }; }
    @PluginMethod public void beginExport(PluginCall call) { exporter.begin(call.getString("name", "headup-export"), call.getString("mime", "application/octet-stream"), call.getLong("size", -1L), reply(call)); }
    @PluginMethod public void appendExport(PluginCall call) { exporter.append(call.getString("token", ""), call.getString("data", ""), reply(call)); }
    @PluginMethod public void finishExport(PluginCall call) { exporter.finish(call.getString("token", ""), reply(call)); }
    @PluginMethod public void abortExport(PluginCall call) { exporter.abort(call.getString("token", "")); call.resolve(); }
    // Keep legacy bridge calls fail-closed when an old web page is still alive.
    @PluginMethod public void photoDirectory(PluginCall call) { call.reject("当前版本仅在应用内保存照片"); }
    @PluginMethod public void beginPhotoCopy(PluginCall call) { call.reject("当前版本仅在应用内保存照片"); }
    @PluginMethod public void appendPhotoCopy(PluginCall call) { call.reject("当前版本仅在应用内保存照片"); }
    @PluginMethod public void finishPhotoCopy(PluginCall call) { call.reject("当前版本仅在应用内保存照片"); }
    @PluginMethod public void abortPhotoCopy(PluginCall call) { call.resolve(); }
    @Override protected void handleOnDestroy() { if (exporter != null) exporter.close(); }
}
