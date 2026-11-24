import datetime
import os


def today():
    pinned = os.environ.get("BENCH_TODAY")
    return datetime.date.fromisoformat(pinned) if pinned else datetime.date.today()


def add_business_days(day, count):
    while count > 0:
        day += datetime.timedelta(days=1)
        if day.weekday() < 5:
            count -= 1
    return day


def short_day(day):
    return f"{day:%a}, {day:%b} {day.day}"


def long_day(day):
    return f"{day:%A}, {day:%b} {day.day}"


def month_day(day):
    return f"{day:%b} {day.day}"


def full_date(day):
    return f"{day:%b} {day.day}, {day.year}"


def long_date(day):
    return f"{day:%A}, {day:%B} {day.day}, {day.year}"
