package com.headup.growth;

import org.junit.Test;
import static org.junit.Assert.*;

public class ServerAddressTest {
    @Test public void normalizesHttpsOrigin() {
        assertEquals("https://example.com",ServerAddress.normalize(" https://EXAMPLE.com:443/ "));
        assertEquals("https://192.168.1.50:8443",ServerAddress.normalize("https://192.168.1.50:8443/"));
    }
    @Test public void rejectsCredentialsPathsParametersAndLocalhost() {
        for(String input:new String[]{"http://example.com","file:///private","https://user:secret@example.com","https://example.com/path","https://example.com/?token=x","https://example.com/#private","https://localhost","https://localhost.","https://127.0.0.1","https://[::1]","https://0.0.0.0","https://example.com:0","https://example.com:65536","not a url"}) {
            try {ServerAddress.normalize(input);fail("Should reject: "+input);}catch(IllegalArgumentException expected) {}
        }
    }
}
