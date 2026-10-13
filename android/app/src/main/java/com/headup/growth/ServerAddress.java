package com.headup.growth;

import java.net.URI;
import java.util.Locale;

final class ServerAddress {
    static String normalize(String value) {
        try {
            URI uri = new URI(value.trim());
            String host = uri.getHost();
            if (!"https".equalsIgnoreCase(uri.getScheme()) || host == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null) throw new Exception();
            if (uri.getPath() != null && !uri.getPath().isEmpty() && !uri.getPath().equals("/")) throw new Exception();
            host = host.toLowerCase(Locale.ROOT);
            if (host.equals("localhost") || host.equals("localhost.") || host.endsWith(".localhost") || host.startsWith("127.") || host.equals("0.0.0.0") || host.equals("[::1]") || host.equals("::1")) throw new Exception();
            int port = uri.getPort();
            if (port == 0 || port > 65535 || port < -1) throw new Exception();
            return new URI("https", null, host, port == 443 ? -1 : port, null, null, null).toASCIIString();
        } catch (Exception error) { throw new IllegalArgumentException("请填写有效的HTTPS站点地址，不含账号、路径、查询参数或localhost。例：https://headup.example.com"); }
    }
}
