FROM python:3.12-slim
WORKDIR /app
COPY . .
# Bundle browser libraries and the NASA terrain products (LOLA elevation, PGDA illumination maps and,
# with --hires, the 5 m site maps) so the hosted app needs no first-run step.
RUN python server.py --fetch-vendor || echo "vendor download skipped"
RUN python server.py --build-terrain --hires || python server.py --build-terrain --quick || echo "terrain build skipped"
RUN python tools/validation_report.py || echo "validation report skipped"
ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["python", "server.py"]
