package main

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	host := os.Args[1]
	for _, h2 := range []bool{false, true} {
		tr := &http.Transport{TLSClientConfig: &tls.Config{}, ForceAttemptHTTP2: h2}
		if !h2 {
			tr.TLSNextProto = map[string]func(string, *tls.Conn) http.RoundTripper{}
		}
		c := &http.Client{Transport: tr, Timeout: 15 * time.Second}
		t := time.Now()
		r, err := c.Post("https://"+host+"/mcp", "application/json", strings.NewReader("{}"))
		if err != nil {
			fmt.Println("go h2=", h2, "ERR", err, time.Since(t))
			continue
		}
		fmt.Println("go h2=", h2, r.StatusCode, r.Proto, r.TLS.CurveID, time.Since(t))
		r.Body.Close()
	}
}
